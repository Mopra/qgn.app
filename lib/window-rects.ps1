# QGN window-rect helper.
#
# Windows exposes no way for Electron to read other applications' window
# bounds, which is what snap-to-window in the capture overlay needs. This runs
# as one long-lived child process: it compiles the P/Invoke shim once at
# startup, then answers a request per line on stdin with a single line of
# "x,y,w,h;x,y,w,h;..." on stdout. Compilation is the slow part (~800ms) and it
# happens once, so every request after the first costs a couple of milliseconds.
#
# Coordinates are PHYSICAL pixels: the process opts into per-monitor DPI
# awareness so a scaled display reports true pixels rather than virtualised
# ones. The main process converts them to the overlay's CSS pixels.

param(
  # QGN's own process id. Its windows are skipped: the capture overlay is a
  # full-screen window and would otherwise be offered as a snap target covering
  # everything behind it.
  [int]$ExcludePid = 0
)

$ErrorActionPreference = "Stop"

Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;

public class QgnWin {
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out RECT r, int s);

  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }

  const int GWL_EXSTYLE = -20;
  const int WS_EX_TOOLWINDOW = 0x00000080;
  const int WS_EX_NOREDIRECTIONBITMAP = 0x00200000;
  const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;
  const int DWMWA_CLOAKED = 14;

  public static void MakeDpiAware() {
    try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch {} // PER_MONITOR_AWARE_V2
  }

  public static uint ExcludePid = 0;

  public static string List() {
    var sb = new StringBuilder();
    EnumWindows(delegate(IntPtr h, IntPtr p) {
      if (!IsWindowVisible(h) || IsIconic(h)) return true;
      if (GetWindowTextLength(h) == 0) return true;

      if (ExcludePid != 0) {
        uint owner;
        GetWindowThreadProcessId(h, out owner);
        if (owner == ExcludePid) return true;
      }

      int ex = GetWindowLong(h, GWL_EXSTYLE);
      if ((ex & WS_EX_TOOLWINDOW) != 0) return true;

      // The desktop and taskbar are windows too, and full-screen ones at that.
      // Offering them as snap targets would put a screen-sized rect under every
      // hover that missed a real window.
      var cls = new StringBuilder(64);
      GetClassName(h, cls, cls.Capacity);
      string c = cls.ToString();
      if (c == "Progman" || c == "WorkerW" || c == "Shell_TrayWnd" ||
          c == "Shell_SecondaryTrayWnd" || c == "Windows.UI.Core.CoreWindow") return true;

      // Cloaked windows are the invisible shells UWP and virtual desktops leave
      // behind; they report plausible bounds but are not on screen.
      int cloaked = 0;
      try {
        RECT tmp;
        if (DwmGetWindowAttribute(h, DWMWA_CLOAKED, out tmp, 4) == 0) cloaked = tmp.Left;
      } catch {}
      if (cloaked != 0) return true;

      // The DWM frame bounds exclude the invisible resize border that
      // GetWindowRect includes, so a snapped rect matches what the user sees.
      RECT r;
      if (DwmGetWindowAttribute(h, DWMWA_EXTENDED_FRAME_BOUNDS, out r, Marshal.SizeOf(typeof(RECT))) != 0) {
        if (!GetWindowRect(h, out r)) return true;
      }

      int w = r.Right - r.Left;
      int ht = r.Bottom - r.Top;
      if (w < 40 || ht < 40) return true;

      sb.Append(r.Left).Append(',').Append(r.Top).Append(',').Append(w).Append(',').Append(ht).Append(';');
      return true;
    }, IntPtr.Zero);
    return sb.ToString();
  }
}
"@

[QgnWin]::MakeDpiAware()
if ($ExcludePid -gt 0) { [QgnWin]::ExcludePid = [uint32]$ExcludePid }

# Ready line, so the parent knows compilation finished.
[Console]::Out.WriteLine("READY")
[Console]::Out.Flush()

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  try {
    [Console]::Out.WriteLine([QgnWin]::List())
  } catch {
    [Console]::Out.WriteLine("")
  }
  [Console]::Out.Flush()
}
