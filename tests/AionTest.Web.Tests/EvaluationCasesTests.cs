using System.Text.Json;
using Xunit;

namespace AionTest.Web.Tests;

public sealed class EvaluationCasesTests
{
    [Fact]
    public void EvaluationCases_HaveEightCategoriesWithThreeSizesEach()
    {
        var path = Path.Combine(AppContext.BaseDirectory, "evaluation-cases.json");
        using var document = JsonDocument.Parse(File.ReadAllText(path));
        var cases = document.RootElement.GetProperty("cases").EnumerateArray().ToArray();

        Assert.Equal("1.0", document.RootElement.GetProperty("schemaVersion").GetString());
        Assert.Equal(24, cases.Length);

        var grouped = cases.GroupBy(item => item.GetProperty("category").GetString());
        Assert.Equal(8, grouped.Count());
        foreach (var category in grouped)
        {
            Assert.Equal(["long", "medium", "short"], category.Select(item => item.GetProperty("size").GetString()!).Order().ToArray());
            Assert.All(category, item =>
            {
                Assert.False(string.IsNullOrWhiteSpace(item.GetProperty("id").GetString()));
                Assert.False(string.IsNullOrWhiteSpace(item.GetProperty("instruction").GetString()));
                Assert.False(string.IsNullOrWhiteSpace(item.GetProperty("input").GetString()));
                Assert.True(item.GetProperty("evaluationCriteria").GetArrayLength() > 0);
            });
        }
    }
}
