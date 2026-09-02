Add-Type @'
using System;
using System.Runtime.InteropServices;

public class Win32Helper {
    [StructLayout(LayoutKind.Sequential)]
    public struct LASTINPUTINFO {
        public uint cbSize;
        public uint dwTime;
    }

    [DllImport("user32.dll")]
    public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);

    [DllImport("kernel32.dll")]
    public static extern uint GetTickCount();

    public static uint GetIdleTimeSeconds() {
        LASTINPUTINFO lii = new LASTINPUTINFO();
        lii.cbSize = (uint)Marshal.SizeOf(lii);
        if (GetLastInputInfo(ref lii)) {
            return (GetTickCount() - lii.dwTime) / 1000;
        }
        return 0;
    }
}
'@ -ErrorAction SilentlyContinue

[Win32Helper]::GetIdleTimeSeconds()
