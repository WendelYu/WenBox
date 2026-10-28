// WenBox M0 read-only observer. No hooks, input injection, key or clipboard collection.
using System;
using System.Runtime.InteropServices;
using System.Text;

namespace WenBox.M0
{
    public sealed class DesktopSample
    {
        public string Utc;
        public string Desktop;
        public int DesktopError;
        public bool CursorQueryOk;
        public bool CursorShowing;
        public int CursorError;
        public bool MousePresent;
    }

    public static class DesktopProbe
    {
        [StructLayout(LayoutKind.Sequential)]
        private struct Point { public int X; public int Y; }
        [StructLayout(LayoutKind.Sequential)]
        private struct CursorInfo
        {
            public int Size;
            public int Flags;
            public IntPtr Cursor;
            public Point Position;
        }
        [DllImport("user32.dll", SetLastError = true)]
        private static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool CloseDesktop(IntPtr desktop);
        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool GetUserObjectInformation(IntPtr handle, int index,
            StringBuilder value, int bytes, out int needed);
        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool GetCursorInfo(ref CursorInfo info);
        [DllImport("user32.dll")]
        private static extern int GetSystemMetrics(int index);

        public static DesktopSample Read()
        {
            var sample = new DesktopSample();
            sample.Utc = DateTime.UtcNow.ToString("o");
            // DESKTOP_READOBJECTS only; never switch or attach to another desktop.
            IntPtr desktop = OpenInputDesktop(0, false, 0x0001);
            if (desktop == IntPtr.Zero)
            {
                sample.DesktopError = Marshal.GetLastWin32Error();
                sample.Desktop = "unavailable";
            }
            else
            {
                try
                {
                    var name = new StringBuilder(256);
                    int needed;
                    if (GetUserObjectInformation(desktop, 2, name, name.Capacity * 2, out needed))
                        sample.Desktop = name.ToString();
                    else
                    {
                        sample.DesktopError = Marshal.GetLastWin32Error();
                        sample.Desktop = "unavailable";
                    }
                }
                finally { CloseDesktop(desktop); }
            }
            var cursor = new CursorInfo();
            cursor.Size = Marshal.SizeOf(typeof(CursorInfo));
            sample.CursorQueryOk = GetCursorInfo(ref cursor);
            sample.CursorError = sample.CursorQueryOk ? 0 : Marshal.GetLastWin32Error();
            sample.CursorShowing = sample.CursorQueryOk && (cursor.Flags & 1) != 0;
            sample.MousePresent = GetSystemMetrics(19) != 0; // SM_MOUSEPRESENT, not physical proof
            return sample;
        }
    }
}
