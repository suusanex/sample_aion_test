#:property TargetFramework=net10.0
#:property PublishAot=false

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

var options = ParseArguments(args);

if (options.ShowHelp)
{
    ShowUsage();
    return 0;
}

try
{
    ValidateOptions(options);

    var outputDirectory = Path.GetFullPath(options.OutputDirectory);
    Directory.CreateDirectory(outputDirectory);

    var collected = await CollectPrReviewDataAsync(options);

    string? checks = null;
    if (options.IncludeChecks)
    {
        checks = await RunGhAsync(
            "pr",
            "checks",
            options.PullRequestNumber.ToString(),
            "--repo",
            options.Repository,
            "--json",
            "name,state,startedAt,completedAt,link,bucket");
    }

    using var prViewJson = JsonDocument.Parse(collected.PrView);
    using var reviewCommentsJson = JsonDocument.Parse(collected.ReviewComments);
    using var checksJson = checks is null ? null : JsonDocument.Parse(checks);

    var context = new Dictionary<string, object?>
    {
        ["generatedAt"] = DateTimeOffset.UtcNow,
        ["repository"] = options.Repository,
        ["pullRequest"] = options.PullRequestNumber,
        ["includeChecks"] = options.IncludeChecks,
        ["copilotReviewWait"] = collected.CopilotReviewWait.ToDictionary(),
        ["sources"] = new Dictionary<string, object?>
        {
            ["prView"] = prViewJson.RootElement.Clone(),
            ["reviewComments"] = reviewCommentsJson.RootElement.Clone(),
            ["checks"] = checksJson?.RootElement.Clone()
        }
    };

    var jsonOptions = new JsonSerializerOptions
    {
        WriteIndented = true
    };

    var jsonPath = Path.Combine(outputDirectory, "review-context.json");
    var markdownPath = Path.Combine(outputDirectory, "review-context.md");

    File.WriteAllText(jsonPath, JsonSerializer.Serialize(context, jsonOptions), Encoding.UTF8);
    File.WriteAllText(markdownPath, BuildMarkdown(options, prViewJson.RootElement, reviewCommentsJson.RootElement, checksJson?.RootElement, collected.CopilotReviewWait), Encoding.UTF8);

    Console.WriteLine("Review context collected.");
    Console.WriteLine($"Markdown: {markdownPath}");
    Console.WriteLine($"JSON: {jsonPath}");
    return 0;
}
catch (Exception ex)
{
    Trace.WriteLine(ex.ToString());
    Console.Error.WriteLine("Error: failed to collect PR review context.");
    Console.Error.WriteLine(ex.ToString());
    return 1;
}

static Options ParseArguments(string[] args)
{
    var options = new Options();

    for (var i = 0; i < args.Length; i++)
    {
        var arg = args[i];
        switch (arg)
        {
            case "--help":
            case "-h":
                options.ShowHelp = true;
                break;
            case "--repo":
                options.Repository = ReadValue(args, ref i, "--repo");
                break;
            case "--pr":
                var value = ReadValue(args, ref i, "--pr");
                if (!int.TryParse(value, out var number) || number <= 0)
                {
                    throw new ArgumentException("--pr must be a positive integer.");
                }

                options.PullRequestNumber = number;
                break;
            case "--out":
                options.OutputDirectory = ReadValue(args, ref i, "--out");
                break;
            case "--include-checks":
                options.IncludeChecks = true;
                break;
            case "--no-wait-for-copilot":
                options.WaitForCopilot = false;
                break;
            case "--copilot-timeout-seconds":
                options.CopilotTimeoutSeconds = ReadPositiveInteger(args, ref i, "--copilot-timeout-seconds");
                break;
            case "--copilot-poll-interval-seconds":
                options.CopilotPollIntervalSeconds = ReadPositiveInteger(args, ref i, "--copilot-poll-interval-seconds");
                break;
            case "--copilot-stable-samples":
                options.CopilotStableSamples = ReadPositiveInteger(args, ref i, "--copilot-stable-samples");
                break;
            default:
                throw new ArgumentException($"Unknown argument: {arg}");
        }
    }

    return options;
}

static string ReadValue(string[] args, ref int index, string optionName)
{
    if (index + 1 >= args.Length)
    {
        throw new ArgumentException($"{optionName} requires a value.");
    }

    index++;
    return args[index];
}

static int ReadPositiveInteger(string[] args, ref int index, string optionName)
{
    var value = ReadValue(args, ref index, optionName);
    if (!int.TryParse(value, out var number) || number <= 0)
    {
        throw new ArgumentException($"{optionName} must be a positive integer.");
    }

    return number;
}

static void ValidateOptions(Options options)
{
    if (string.IsNullOrWhiteSpace(options.Repository))
    {
        throw new ArgumentException("--repo is required.");
    }

    var parts = options.Repository.Split('/', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
    if (parts.Length != 2)
    {
        throw new ArgumentException("--repo must be in owner/name format.");
    }

    if (options.PullRequestNumber <= 0)
    {
        throw new ArgumentException("--pr is required.");
    }

    if (string.IsNullOrWhiteSpace(options.OutputDirectory))
    {
        throw new ArgumentException("--out is required.");
    }

    options.Owner = parts[0];
    options.Name = parts[1];
}

static async Task<CollectedPrReviewData> CollectPrReviewDataAsync(Options options)
{
    var startedAt = DateTimeOffset.UtcNow;
    var prView = await FetchPrViewAsync(options);
    var normalizedReviewComments = await FetchNormalizedReviewCommentsAsync(options);

    using var startPrViewJson = JsonDocument.Parse(prView);
    var startHeadRefOid = GetString(startPrViewJson.RootElement, "headRefOid");

    if (!options.WaitForCopilot)
    {
        using var reviewCommentsJson = JsonDocument.Parse(normalizedReviewComments);
        var snapshot = AnalyzeCopilotSnapshot(startPrViewJson.RootElement, reviewCommentsJson.RootElement, startHeadRefOid);
        var completedAt = DateTimeOffset.UtcNow;
        return new CollectedPrReviewData(
            prView,
            normalizedReviewComments,
            BuildWaitResult(
                status: "disabled",
                timedOut: false,
                startedAt,
                completedAt,
                startHeadRefOid,
                options,
                snapshot,
                stableSamplesObserved: 0));
    }

    CopilotSnapshot snapshotForResult;
    var stableSamplesObserved = 0;
    string? previousBody = null;
    int? previousInlineCount = null;

    while (true)
    {
        using var prViewJson = JsonDocument.Parse(prView);
        using var reviewCommentsJson = JsonDocument.Parse(normalizedReviewComments);
        snapshotForResult = AnalyzeCopilotSnapshot(prViewJson.RootElement, reviewCommentsJson.RootElement, startHeadRefOid);

        if (IsCopilotSnapshotComplete(snapshotForResult))
        {
            if (string.Equals(previousBody, snapshotForResult.ReviewBody, StringComparison.Ordinal)
                && previousInlineCount == snapshotForResult.ActualInlineCommentCount)
            {
                stableSamplesObserved++;
            }
            else
            {
                previousBody = snapshotForResult.ReviewBody;
                previousInlineCount = snapshotForResult.ActualInlineCommentCount;
                stableSamplesObserved = 1;
            }

            if (stableSamplesObserved >= options.CopilotStableSamples)
            {
                var completedAt = DateTimeOffset.UtcNow;
                return new CollectedPrReviewData(
                    prView,
                    normalizedReviewComments,
                    BuildWaitResult(
                        ResolveCopilotStatus(snapshotForResult, timedOut: false),
                        timedOut: false,
                        startedAt,
                        completedAt,
                        startHeadRefOid,
                        options,
                        snapshotForResult,
                        stableSamplesObserved));
            }
        }
        else
        {
            previousBody = null;
            previousInlineCount = null;
            stableSamplesObserved = 0;
        }

        var elapsed = DateTimeOffset.UtcNow - startedAt;
        var timeout = TimeSpan.FromSeconds(options.CopilotTimeoutSeconds);
        if (elapsed >= timeout)
        {
            var completedAt = DateTimeOffset.UtcNow;
            return new CollectedPrReviewData(
                prView,
                normalizedReviewComments,
                BuildWaitResult(
                    ResolveCopilotStatus(snapshotForResult, timedOut: true),
                    timedOut: true,
                    startedAt,
                    completedAt,
                    startHeadRefOid,
                    options,
                    snapshotForResult,
                    stableSamplesObserved));
        }

        var remaining = timeout - elapsed;
        var delay = TimeSpan.FromSeconds(options.CopilotPollIntervalSeconds);
        if (delay > remaining)
        {
            delay = remaining;
        }

        await Task.Delay(delay);
        prView = await FetchPrViewAsync(options);
        normalizedReviewComments = await FetchNormalizedReviewCommentsAsync(options);
    }
}

static async Task<string> FetchPrViewAsync(Options options)
{
    return await RunGhAsync(
        "pr",
        "view",
        options.PullRequestNumber.ToString(),
        "--repo",
        options.Repository,
        "--json",
        "number,title,state,author,body,url,headRefName,headRefOid,baseRefName,mergeable,isDraft,reviewDecision,latestReviews,reviews,comments,commits,files");
}

static async Task<string> FetchNormalizedReviewCommentsAsync(Options options)
{
    var reviewComments = await RunGhAsync(
        "api",
        $"repos/{options.Owner}/{options.Name}/pulls/{options.PullRequestNumber}/comments",
        "--paginate",
        "--slurp");

    return NormalizePaginatedJsonArray(reviewComments);
}

static async Task<string> RunGhAsync(params string[] arguments)
{
    var startInfo = new ProcessStartInfo
    {
        FileName = "gh",
        RedirectStandardOutput = true,
        RedirectStandardError = true,
        UseShellExecute = false,
        CreateNoWindow = true,
        StandardOutputEncoding = Encoding.UTF8,
        StandardErrorEncoding = Encoding.UTF8
    };

    foreach (var argument in arguments)
    {
        startInfo.ArgumentList.Add(argument);
    }

    using var process = Process.Start(startInfo) ?? throw new InvalidOperationException("Failed to start gh.");
    var outputTask = process.StandardOutput.ReadToEndAsync();
    var errorTask = process.StandardError.ReadToEndAsync();
    await process.WaitForExitAsync();
    var output = await outputTask;
    var error = await errorTask;

    if (process.ExitCode != 0)
    {
        throw new InvalidOperationException($"gh {FormatArguments(arguments)} failed with exit code {process.ExitCode}.{Environment.NewLine}{error}");
    }

    return output;
}

static string NormalizePaginatedJsonArray(string json)
{
    using var document = JsonDocument.Parse(json);
    var root = document.RootElement;
    if (root.ValueKind != JsonValueKind.Array)
    {
        throw new InvalidOperationException("Expected gh api --paginate --slurp to return a JSON array.");
    }

    using var stream = new MemoryStream();
    using (var writer = new Utf8JsonWriter(stream, new JsonWriterOptions { Indented = true }))
    {
        writer.WriteStartArray();
        foreach (var page in root.EnumerateArray())
        {
            if (page.ValueKind == JsonValueKind.Array)
            {
                foreach (var item in page.EnumerateArray())
                {
                    item.WriteTo(writer);
                }

                continue;
            }

            if (page.ValueKind == JsonValueKind.Object)
            {
                page.WriteTo(writer);
                continue;
            }

            throw new InvalidOperationException("Expected each paginated gh api page to be a JSON array or object.");
        }

        writer.WriteEndArray();
    }

    return Encoding.UTF8.GetString(stream.ToArray());
}

static string BuildMarkdown(Options options, JsonElement prView, JsonElement reviewComments, JsonElement? checks, CopilotReviewWaitResult copilotReviewWait)
{
    var builder = new StringBuilder();
    var title = GetString(prView, "title");
    var url = GetString(prView, "url");

    builder.AppendLine("# PR Review Context");
    builder.AppendLine();
    builder.AppendLine("## Target");
    builder.AppendLine();
    builder.AppendLine($"- Repository: {options.Repository}");
    builder.AppendLine($"- PR: #{options.PullRequestNumber}");
    builder.AppendLine($"- Title: {title}");
    builder.AppendLine($"- URL: {url}");
    builder.AppendLine($"- State: {GetString(prView, "state")}");
    builder.AppendLine($"- Draft: {GetBooleanText(prView, "isDraft")}");
    builder.AppendLine($"- Review decision: {GetString(prView, "reviewDecision")}");
    builder.AppendLine($"- Base: {GetString(prView, "baseRefName")}");
    builder.AppendLine($"- Head: {GetString(prView, "headRefName")}");
    builder.AppendLine();

    AppendCopilotReviewWait(builder, copilotReviewWait);
    AppendBody(builder, prView);
    AppendFiles(builder, prView);
    AppendLatestReviews(builder, prView);
    AppendIssueComments(builder, prView);
    AppendReviewComments(builder, reviewComments);
    AppendChecks(builder, checks);
    AppendCopilotNote(builder, prView, reviewComments);

    return builder.ToString();
}

static void AppendCopilotReviewWait(StringBuilder builder, CopilotReviewWaitResult wait)
{
    builder.AppendLine("## GitHub Copilot Review Wait");
    builder.AppendLine();
    builder.AppendLine($"- Status: {wait.Status}");
    builder.AppendLine($"- Timed out: {wait.TimedOut}");
    builder.AppendLine($"- Started at: {wait.StartedAt:O}");
    builder.AppendLine($"- Completed at: {wait.CompletedAt:O}");
    builder.AppendLine($"- Elapsed seconds: {wait.ElapsedSeconds}");
    builder.AppendLine($"- Head commit: {wait.HeadRefOid}");
    builder.AppendLine($"- Timeout seconds: {wait.TimeoutSeconds}");
    builder.AppendLine($"- Poll interval seconds: {wait.PollIntervalSeconds}");
    builder.AppendLine($"- Stable samples observed: {wait.StableSamplesObserved}");
    builder.AppendLine($"- Review found: {wait.ReviewFound}");
    builder.AppendLine($"- Review state: {wait.ReviewState}");
    builder.AppendLine($"- Review submitted at: {wait.ReviewSubmittedAt}");
    builder.AppendLine($"- Expected inline comments: {FormatNullableNumber(wait.ExpectedInlineCommentCount)}");
    builder.AppendLine($"- Actual inline comments: {wait.ActualInlineCommentCount}");
    builder.AppendLine();

    if (wait.TimedOut)
    {
        builder.AppendLine("GitHub Copilot review was not collected before timeout. Treat this as not collected, not as evidence that Copilot had no comments.");
        builder.AppendLine();
        return;
    }

    if (wait.Status == "disabled")
    {
        builder.AppendLine("GitHub Copilot review waiting was disabled for this collection run.");
        builder.AppendLine();
        return;
    }

    builder.AppendLine(wait.Status switch
    {
        "reviewAndInline" => "GitHub Copilot review body and inline comments were collected.",
        "reviewOnly" => "GitHub Copilot review body was collected, but no inline comments were identified.",
        "inlineOnly" => "GitHub Copilot inline comments were collected, but no review body was identified.",
        "none" => "GitHub Copilot review data was not identified.",
        _ => "GitHub Copilot review wait result was recorded."
    });
    builder.AppendLine();
}

static void AppendBody(StringBuilder builder, JsonElement prView)
{
    builder.AppendLine("## PR Body");
    builder.AppendLine();
    builder.AppendLine(GetString(prView, "body"));
    builder.AppendLine();
}

static void AppendFiles(StringBuilder builder, JsonElement prView)
{
    builder.AppendLine("## Changed Files");
    builder.AppendLine();

    if (TryGetArray(prView, "files", out var files))
    {
        foreach (var file in files.EnumerateArray())
        {
            builder.AppendLine($"- {GetString(file, "path")}");
        }
    }

    builder.AppendLine();
}

static void AppendLatestReviews(StringBuilder builder, JsonElement prView)
{
    builder.AppendLine("## Latest Reviews");
    builder.AppendLine();

    if (TryGetArray(prView, "latestReviews", out var reviews))
    {
        foreach (var review in reviews.EnumerateArray())
        {
            var author = GetNestedString(review, "author", "login");
            builder.AppendLine($"### {author} / {GetString(review, "state")}");
            builder.AppendLine();
            builder.AppendLine($"- Submitted at: {GetString(review, "submittedAt")}");
            builder.AppendLine();
            builder.AppendLine(GetString(review, "body"));
            builder.AppendLine();
        }
    }

    builder.AppendLine();
}

static void AppendIssueComments(StringBuilder builder, JsonElement prView)
{
    builder.AppendLine("## PR Comments");
    builder.AppendLine();

    if (TryGetArray(prView, "comments", out var comments))
    {
        foreach (var comment in comments.EnumerateArray())
        {
            var author = GetNestedString(comment, "author", "login");
            builder.AppendLine($"### {author} / {GetString(comment, "createdAt")}");
            builder.AppendLine();
            builder.AppendLine(GetString(comment, "body"));
            builder.AppendLine();
        }
    }

    builder.AppendLine();
}

static void AppendReviewComments(StringBuilder builder, JsonElement reviewComments)
{
    builder.AppendLine("## Review Comments");
    builder.AppendLine();

    if (reviewComments.ValueKind == JsonValueKind.Array)
    {
        foreach (var comment in reviewComments.EnumerateArray())
        {
            var user = GetNestedString(comment, "user", "login");
            builder.AppendLine($"### {user} / {GetString(comment, "path")}:{GetNumberText(comment, "line")}");
            builder.AppendLine();
            builder.AppendLine($"- URL: {GetString(comment, "html_url")}");
            builder.AppendLine($"- Created at: {GetString(comment, "created_at")}");
            builder.AppendLine();
            builder.AppendLine(GetString(comment, "body"));
            builder.AppendLine();
        }
    }

    builder.AppendLine();
}

static void AppendChecks(StringBuilder builder, JsonElement? checks)
{
    builder.AppendLine("## Checks");
    builder.AppendLine();

    if (checks is null)
    {
        builder.AppendLine("Checks were not requested.");
        builder.AppendLine();
        return;
    }

    if (checks.Value.ValueKind == JsonValueKind.Array)
    {
        foreach (var check in checks.Value.EnumerateArray())
        {
            builder.AppendLine($"- {GetString(check, "name")}: state={GetString(check, "state")}, bucket={GetString(check, "bucket")}");
        }
    }

    builder.AppendLine();
}

static void AppendCopilotNote(StringBuilder builder, JsonElement prView, JsonElement reviewComments)
{
    builder.AppendLine("## GitHub Copilot Review Note");
    builder.AppendLine();

    var found = ContainsCopilot(prView) || ContainsCopilot(reviewComments);
    if (found)
    {
        builder.AppendLine("GitHub Copilot related review data was found in the collected PR reviews or comments.");
    }
    else
    {
        builder.AppendLine("GitHub Copilot review data was not identified in the collected PR reviews or comments. Treat this as not collected, not as evidence that no Copilot review exists.");
    }

    builder.AppendLine();
}

static CopilotSnapshot AnalyzeCopilotSnapshot(JsonElement prView, JsonElement reviewComments, string headRefOid)
{
    var review = FindBestCopilotReview(prView, headRefOid);
    var actualInlineCommentCount = CountCopilotInlineComments(reviewComments);
    var reviewBody = review?.Body ?? string.Empty;
    var expectedInlineCommentCount = ExtractGeneratedCommentCount(reviewBody);

    return new CopilotSnapshot(
        ReviewFound: review is not null,
        ReviewState: review?.State ?? string.Empty,
        ReviewSubmittedAt: review?.SubmittedAt ?? string.Empty,
        ReviewBody: reviewBody,
        ReviewIsTerminal: review?.IsTerminal ?? false,
        ExpectedInlineCommentCount: expectedInlineCommentCount,
        ActualInlineCommentCount: actualInlineCommentCount);
}

static CopilotReview? FindBestCopilotReview(JsonElement prView, string headRefOid)
{
    var reviews = new List<CopilotReview>();
    AddCopilotReviews(reviews, prView, "latestReviews", headRefOid);
    AddCopilotReviews(reviews, prView, "reviews", headRefOid);

    return reviews
        .OrderByDescending(review => review.CommitMatchesHead)
        .ThenByDescending(review => review.CommitIsUnknown)
        .ThenByDescending(review => ParseDateTimeOffset(review.SubmittedAt))
        .FirstOrDefault();
}

static void AddCopilotReviews(List<CopilotReview> reviews, JsonElement prView, string propertyName, string headRefOid)
{
    if (!TryGetArray(prView, propertyName, out var reviewArray))
    {
        return;
    }

    foreach (var review in reviewArray.EnumerateArray())
    {
        var author = GetNestedString(review, "author", "login");
        if (!IsCopilotLogin(author))
        {
            continue;
        }

        var state = GetString(review, "state");
        var commitOid = GetNestedString(review, "commit", "oid");
        var commitMatchesHead = !string.IsNullOrWhiteSpace(headRefOid)
            && string.Equals(commitOid, headRefOid, StringComparison.OrdinalIgnoreCase);
        var commitIsUnknown = string.IsNullOrWhiteSpace(commitOid);
        reviews.Add(new CopilotReview(
            State: state,
            SubmittedAt: GetString(review, "submittedAt"),
            Body: GetString(review, "body"),
            CommitMatchesHead: commitMatchesHead,
            CommitIsUnknown: commitIsUnknown,
            IsTerminal: IsTerminalReviewState(state)));
    }
}

static bool IsTerminalReviewState(string state)
{
    return state is "COMMENTED" or "APPROVED" or "CHANGES_REQUESTED";
}

static int CountCopilotInlineComments(JsonElement reviewComments)
{
    if (reviewComments.ValueKind != JsonValueKind.Array)
    {
        return 0;
    }

    return reviewComments.EnumerateArray()
        .Count(comment => IsCopilotLogin(GetNestedString(comment, "user", "login")));
}

static bool IsCopilotLogin(string login)
{
    return login.Contains("copilot", StringComparison.OrdinalIgnoreCase);
}

static int? ExtractGeneratedCommentCount(string body)
{
    if (string.IsNullOrWhiteSpace(body))
    {
        return null;
    }

    var match = Regex.Match(body, @"generated\s+(\d+)\s+comments?", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    if (!match.Success || !int.TryParse(match.Groups[1].Value, out var count))
    {
        return null;
    }

    return count;
}

static bool IsCopilotSnapshotComplete(CopilotSnapshot snapshot)
{
    if (snapshot.ReviewFound)
    {
        if (!snapshot.ReviewIsTerminal)
        {
            return false;
        }

        return snapshot.ExpectedInlineCommentCount is null
            || snapshot.ActualInlineCommentCount >= snapshot.ExpectedInlineCommentCount.Value;
    }

    return snapshot.ActualInlineCommentCount > 0;
}

static string ResolveCopilotStatus(CopilotSnapshot snapshot, bool timedOut)
{
    if (timedOut)
    {
        return "timeout";
    }

    if (snapshot.ReviewFound && snapshot.ActualInlineCommentCount > 0)
    {
        return "reviewAndInline";
    }

    if (snapshot.ReviewFound)
    {
        return "reviewOnly";
    }

    if (snapshot.ActualInlineCommentCount > 0)
    {
        return "inlineOnly";
    }

    return "none";
}

static CopilotReviewWaitResult BuildWaitResult(
    string status,
    bool timedOut,
    DateTimeOffset startedAt,
    DateTimeOffset completedAt,
    string headRefOid,
    Options options,
    CopilotSnapshot snapshot,
    int stableSamplesObserved)
{
    return new CopilotReviewWaitResult(
        Status: status,
        TimedOut: timedOut,
        StartedAt: startedAt,
        CompletedAt: completedAt,
        ElapsedSeconds: Math.Round((completedAt - startedAt).TotalSeconds, 3),
        HeadRefOid: headRefOid,
        TimeoutSeconds: options.CopilotTimeoutSeconds,
        PollIntervalSeconds: options.CopilotPollIntervalSeconds,
        StableSamplesObserved: stableSamplesObserved,
        ReviewFound: snapshot.ReviewFound,
        ReviewState: snapshot.ReviewState,
        ReviewSubmittedAt: snapshot.ReviewSubmittedAt,
        ExpectedInlineCommentCount: snapshot.ExpectedInlineCommentCount,
        ActualInlineCommentCount: snapshot.ActualInlineCommentCount);
}

static DateTimeOffset ParseDateTimeOffset(string value)
{
    return DateTimeOffset.TryParse(value, out var parsed) ? parsed : DateTimeOffset.MinValue;
}

static string FormatNullableNumber(int? value)
{
    return value?.ToString() ?? string.Empty;
}

static bool ContainsCopilot(JsonElement element)
{
    return element.ValueKind switch
    {
        JsonValueKind.Object => element.EnumerateObject().Any(property => ContainsCopilot(property.Value)),
        JsonValueKind.Array => element.EnumerateArray().Any(ContainsCopilot),
        JsonValueKind.String => (element.GetString() ?? string.Empty).Contains("copilot", StringComparison.OrdinalIgnoreCase),
        _ => false
    };
}

static bool TryGetArray(JsonElement element, string propertyName, out JsonElement array)
{
    if (element.ValueKind == JsonValueKind.Object
        && element.TryGetProperty(propertyName, out var property)
        && property.ValueKind == JsonValueKind.Array)
    {
        array = property;
        return true;
    }

    array = default;
    return false;
}

static string GetString(JsonElement element, string propertyName)
{
    if (element.ValueKind != JsonValueKind.Object || !element.TryGetProperty(propertyName, out var property))
    {
        return string.Empty;
    }

    return property.ValueKind switch
    {
        JsonValueKind.String => property.GetString() ?? string.Empty,
        JsonValueKind.Number => property.ToString(),
        JsonValueKind.True => "true",
        JsonValueKind.False => "false",
        JsonValueKind.Null => string.Empty,
        _ => property.ToString()
    };
}

static string GetNestedString(JsonElement element, string objectName, string propertyName)
{
    if (element.ValueKind != JsonValueKind.Object
        || !element.TryGetProperty(objectName, out var nested)
        || nested.ValueKind != JsonValueKind.Object)
    {
        return string.Empty;
    }

    return GetString(nested, propertyName);
}

static string GetBooleanText(JsonElement element, string propertyName)
{
    if (element.ValueKind == JsonValueKind.Object
        && element.TryGetProperty(propertyName, out var property)
        && (property.ValueKind == JsonValueKind.True || property.ValueKind == JsonValueKind.False))
    {
        return property.GetBoolean().ToString();
    }

    return string.Empty;
}

static string GetNumberText(JsonElement element, string propertyName)
{
    if (element.ValueKind == JsonValueKind.Object
        && element.TryGetProperty(propertyName, out var property)
        && property.ValueKind == JsonValueKind.Number)
    {
        return property.ToString();
    }

    return string.Empty;
}

static string FormatArguments(IEnumerable<string> arguments)
{
    return string.Join(" ", arguments.Select(QuoteArgument));
}

static string QuoteArgument(string argument)
{
    return argument.Any(char.IsWhiteSpace) ? $"\"{argument.Replace("\"", "\\\"")}\"" : argument;
}

static void ShowUsage()
{
    Console.WriteLine("""
Usage:
  dotnet run --file scripts/collect-pr-review-context.cs -- --repo owner/name --pr 123 --out .review/pr-123 [--include-checks]

Options:
  --repo owner/name     GitHub repository.
  --pr number           Pull request number.
  --out directory       Output directory for review-context.md and review-context.json.
  --include-checks      Include gh pr checks output.
  --no-wait-for-copilot Disable GitHub Copilot review wait.
  --copilot-timeout-seconds seconds
                       Timeout for GitHub Copilot review wait. Default: 180.
  --copilot-poll-interval-seconds seconds
                       Poll interval for GitHub Copilot review wait. Default: 10.
  --copilot-stable-samples count
                       Required consecutive stable samples. Default: 2.
  --help                Show this help.
""");
}

sealed class Options
{
    public string Repository { get; set; } = string.Empty;

    public string Owner { get; set; } = string.Empty;

    public string Name { get; set; } = string.Empty;

    public int PullRequestNumber { get; set; }

    public string OutputDirectory { get; set; } = string.Empty;

    public bool IncludeChecks { get; set; }

    public bool WaitForCopilot { get; set; } = true;

    public int CopilotTimeoutSeconds { get; set; } = 180;

    public int CopilotPollIntervalSeconds { get; set; } = 10;

    public int CopilotStableSamples { get; set; } = 2;

    public bool ShowHelp { get; set; }
}

sealed record CollectedPrReviewData(
    string PrView,
    string ReviewComments,
    CopilotReviewWaitResult CopilotReviewWait);

sealed record CopilotReview(
    string State,
    string SubmittedAt,
    string Body,
    bool CommitMatchesHead,
    bool CommitIsUnknown,
    bool IsTerminal);

sealed record CopilotSnapshot(
    bool ReviewFound,
    string ReviewState,
    string ReviewSubmittedAt,
    string ReviewBody,
    bool ReviewIsTerminal,
    int? ExpectedInlineCommentCount,
    int ActualInlineCommentCount);

sealed record CopilotReviewWaitResult(
    string Status,
    bool TimedOut,
    DateTimeOffset StartedAt,
    DateTimeOffset CompletedAt,
    double ElapsedSeconds,
    string HeadRefOid,
    int TimeoutSeconds,
    int PollIntervalSeconds,
    int StableSamplesObserved,
    bool ReviewFound,
    string ReviewState,
    string ReviewSubmittedAt,
    int? ExpectedInlineCommentCount,
    int ActualInlineCommentCount)
{
    public Dictionary<string, object?> ToDictionary()
    {
        return new Dictionary<string, object?>
        {
            ["status"] = Status,
            ["timedOut"] = TimedOut,
            ["elapsedSeconds"] = ElapsedSeconds,
            ["startedAt"] = StartedAt,
            ["completedAt"] = CompletedAt,
            ["headRefOid"] = HeadRefOid,
            ["timeoutSeconds"] = TimeoutSeconds,
            ["pollIntervalSeconds"] = PollIntervalSeconds,
            ["reviewFound"] = ReviewFound,
            ["reviewState"] = ReviewState,
            ["reviewSubmittedAt"] = ReviewSubmittedAt,
            ["expectedInlineCommentCount"] = ExpectedInlineCommentCount,
            ["actualInlineCommentCount"] = ActualInlineCommentCount,
            ["stableSamplesObserved"] = StableSamplesObserved
        };
    }
}
