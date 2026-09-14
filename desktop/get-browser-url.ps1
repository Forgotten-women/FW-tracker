param (
    [int64]$Hwnd = 0
)

Add-Type -ReferencedAssemblies "UIAutomationClient", "UIAutomationTypes" @'
using System;
using System.Diagnostics;
using System.Windows.Automation;
using System.Runtime.InteropServices;

public class BrowserUrlTracker {
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    public static string GetUrl(IntPtr hwnd) {
        if (hwnd == IntPtr.Zero) {
            hwnd = GetForegroundWindow();
        }
        if (hwnd == IntPtr.Zero) return "";

        try {
            AutomationElement root = AutomationElement.FromHandle(hwnd);
            if (root == null) return "";

            // Search for Edit controls in the browser UI tree
            Condition condEdit = new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Edit);
            AutomationElementCollection edits = root.FindAll(TreeScope.Descendants, condEdit);

            foreach (AutomationElement edit in edits) {
                try {
                    object patternObj;
                    // Check ValuePattern first (standard in Chromium/Edge)
                    if (edit.TryGetCurrentPattern(ValuePattern.Pattern, out patternObj)) {
                        ValuePattern valPat = (ValuePattern)patternObj;
                        string val = valPat.Current.Value;
                        if (!string.IsNullOrEmpty(val) && (val.Contains(".") || val.StartsWith("http") || val.Contains(":"))) {
                            return val.Trim();
                        }
                    }
                    // Fallback to TextPattern
                    if (edit.TryGetCurrentPattern(TextPattern.Pattern, out patternObj)) {
                        TextPattern txtPat = (TextPattern)patternObj;
                        string val = txtPat.DocumentRange.GetText(-1);
                        if (!string.IsNullOrEmpty(val) && (val.Contains(".") || val.StartsWith("http") || val.Contains(":"))) {
                            return val.Trim();
                        }
                    }
                } catch {}
            }
        } catch {}
        return "";
    }
}
'@ -ErrorAction SilentlyContinue

try {
    $targetHwnd = if ($Hwnd -ne 0) { [IntPtr]$Hwnd } else { [BrowserUrlTracker]::GetForegroundWindow() }
    $url = [BrowserUrlTracker]::GetUrl($targetHwnd)
    if ($url) {
        Write-Output $url
    }
} catch {}
