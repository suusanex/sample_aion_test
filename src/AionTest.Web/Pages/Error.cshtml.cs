using Microsoft.AspNetCore.Diagnostics;
using Microsoft.AspNetCore.Mvc.RazorPages;

namespace AionTest.Web.Pages;

public sealed class ErrorModel(ILogger<ErrorModel> logger) : PageModel
{
    public void OnGet()
    {
        var exception = HttpContext.Features.Get<IExceptionHandlerFeature>()?.Error;
        if (exception is not null)
        {
            logger.LogError(exception, "Unhandled request exception");
        }
    }
}
