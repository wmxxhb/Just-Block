using System;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Text.RegularExpressions;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.ServiceProcess;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Threading;
using System.Web.Script.Serialization;
using System.Runtime.InteropServices;
[assembly: System.Reflection.AssemblyVersion("1.1.1.0")]
[assembly: System.Reflection.AssemblyFileVersion("1.1.1.0")]

internal static class Program {
    internal const string PipeName = "JustBlock.Guardian.v1";
    internal static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 1048576 };
    internal static string DataDirectory { get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "JustBlock"); } }
    internal static int Main(string[] args) {
        if (args.Length > 0 && args[0] == "--service") {
            ServiceBase.Run(new Guardian());
            return 0;
        }
        if (args.Length > 0 && args[0] == "--prepare-uninstall") {
            try {
                string response = Exchange("{\"command\":\"prepare-uninstall\"}");
                Console.WriteLine(response);
                return Json.Deserialize<Dictionary<string, object>>(response).ContainsKey("error") ? 1 : 0;
            } catch (Exception error) { Console.Error.WriteLine(error.Message); return 1; }
        }
        // Chrome starts this mode on demand and exchanges a single framed JSON message.
        try {
            Stream input = Console.OpenStandardInput();
            byte[] size = ReadExactly(input, 4);
            int length = BitConverter.ToInt32(size, 0);
            if (length < 1 || length > 1048576) return 1;
            string body = Encoding.UTF8.GetString(ReadExactly(input, length));
            string result;
            try { result = Exchange(body); }
            catch { result = Json.Serialize(new { error = "系统保护程序未运行或无法连接，请检查 Windows 服务 JustBlockGuardian。" }); }
            byte[] payload = Encoding.UTF8.GetBytes(result);
            Stream output = Console.OpenStandardOutput();
            output.Write(BitConverter.GetBytes(payload.Length), 0, 4);
            output.Write(payload, 0, payload.Length);
            output.Flush();
            return 0;
        } catch { return 1; }
    }
    private static byte[] ReadExactly(Stream stream, int length) {
        byte[] data = new byte[length];
        int offset = 0;
        while (offset < length) {
            int count = stream.Read(data, offset, length - offset);
            if (count == 0) throw new EndOfStreamException();
            offset += count;
        }
        return data;
    }
    private static string Exchange(string body) {
        using (var pipe = new NamedPipeClientStream(".", PipeName, PipeDirection.InOut)) {
            pipe.Connect(5000);
            using (var writer = new StreamWriter(pipe, new UTF8Encoding(false), 4096, true))
            using (var reader = new StreamReader(pipe, Encoding.UTF8, false, 4096, true)) {
                writer.WriteLine(body); writer.Flush();
                return reader.ReadLine();
            }
        }
    }
}

internal sealed class Guardian : ServiceBase {
    private const int Protocol = 3;
    private static readonly int[] QuestionMinimums = new int[] { 10, 10, 5, 5, 5 };
    // Filled from the same source as the extension during packaging.
    private const string Passage = "我主动封禁这个网站，是因为我知道自己会在这里浪费时间。不要再用随便看看欺骗自己，也不要把逃避正事包装成查找资料。推荐内容没有终点，我的时间却不会回来。我写下的任务还没完成，继续刷下去，它们也不会自己消失。现在停下来，记住这次进入的目的和退出条件。我只有十分钟，完成目标就关闭页面，不点开无关推荐，不继续寻找下一条内容。如果我根本没有明确的目的，就承认自己只是在找借口，关掉这个页面，回去做重要的事情。";
    private const string StartMarker = "# BEGIN JUST BLOCK GUARDIAN";
    private const string EndMarker = "# END JUST BLOCK GUARDIAN";
    private readonly object gate = new object();
    private readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 1048576 };
    private List<string> domains = new List<string>();
    private readonly Dictionary<string, long> grants = new Dictionary<string, long>();
    private readonly Dictionary<string, Challenge> challenges = new Dictionary<string, Challenge>();
    private long manageUntil;
    private Timer expiry;
    private NamedPipeServerStream listener;
    private volatile bool stopping;
    private string configPath { get { return Path.Combine(Program.DataDirectory, "config.json"); } }
    private string hostsPath { get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "drivers", "etc", "hosts"); } }
    [DllImport("dnsapi.dll", SetLastError = true)]
    private static extern bool DnsFlushResolverCache();
    private static long Now { get { return (long)(Stopwatch.GetTimestamp() * 1000.0 / Stopwatch.Frequency); } }
    internal Guardian() { ServiceName = "JustBlockGuardian"; AutoLog = true; }

    protected override void OnStart(string[] args) {
        Directory.CreateDirectory(Program.DataDirectory);
        if (File.Exists(configPath)) domains = Normalize(json.Deserialize<List<string>>(File.ReadAllText(configPath)));
        else { domains = new List<string> { "x.com", "twitter.com" }; SaveConfig(); }
        WriteHosts();
        expiry = new Timer(OnExpiry, null, Timeout.Infinite, Timeout.Infinite);
        var thread = new Thread(Listen) { IsBackground = true, Name = "JustBlock IPC" };
        thread.Start();
    }
    protected override void OnStop() {
        stopping = true;
        lock (gate) {
            if (expiry != null) expiry.Dispose();
            grants.Clear();
            // Stopping the service alone must not unblock sites.
            if (!preparedForRemoval) WriteHosts();
        }
        if (listener != null) listener.Dispose();
    }
    private bool preparedForRemoval;

    private void Listen() {
        while (!stopping) {
            try {
                var security = new PipeSecurity();
                security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.NetworkSid, null), PipeAccessRights.FullControl, AccessControlType.Deny));
                string owner = File.ReadAllText(Path.Combine(Program.DataDirectory, "owner.sid")).Trim();
                security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(owner), PipeAccessRights.ReadWrite, AccessControlType.Allow));
                security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), PipeAccessRights.FullControl, AccessControlType.Allow));
                listener = new NamedPipeServerStream(Program.PipeName, PipeDirection.InOut, 4, PipeTransmissionMode.Byte, PipeOptions.None, 4096, 4096, security);
                listener.WaitForConnection();
                var connected = listener;
                listener = null;
                ThreadPool.QueueUserWorkItem(delegate { Serve(connected); });
            } catch (ObjectDisposedException) { if (stopping) return; }
            catch (Exception error) {
                if (stopping) return;
                EventLog.WriteEntry(ServiceName, error.Message, EventLogEntryType.Error);
                Thread.Sleep(1000);
            }
        }
    }
    private void Serve(NamedPipeServerStream pipe) {
        try {
            using (pipe)
            using (var reader = new StreamReader(pipe, Encoding.UTF8, false, 4096, true))
            using (var writer = new StreamWriter(pipe, new UTF8Encoding(false), 4096, true)) {
                // Limit memory even if another local program connects directly.
                var line = new StringBuilder();
                int character;
                while ((character = reader.Read()) >= 0 && character != '\n') {
                    if (line.Length >= 65536) throw new InvalidDataException("请求过长。");
                    line.Append((char)character);
                }
                string response;
                lock (gate) {
                    try {
                        var request = json.Deserialize<Dictionary<string, object>>(line.ToString());
                        response = json.Serialize(Handle(request));
                    } catch (Exception error) { response = json.Serialize(new { error = error.Message }); }
                }
                writer.WriteLine(response); writer.Flush();
            }
        } catch (IOException) { }
        catch (ObjectDisposedException) { }
    }

    private object Handle(Dictionary<string, object> request) {
        Prune();
        string command = Text(request, "command");
        if (command == "status") return new { domains = domains, running = true, protocol = Protocol };
        if (command == "configure") {
            var next = Normalize(json.ConvertToType<List<string>>(request["domains"]));
            if (domains.Any(site => !next.Contains(site)) && manageUntil <= Now)
                throw new InvalidOperationException("系统保护：删除或修改名单前，请先完成解锁流程。");
            var previous = domains;
            domains = next;
            try { SaveConfig(); WriteHosts(); }
            catch { domains = previous; SaveConfig(); WriteHosts(); throw; }
            return new { domains = domains, protocol = Protocol };
        }
        if (command == "begin") {
            string id = Text(request, "id");
            string kind = Text(request, "kind");
            string site = Text(request, "site");
            if (id.Length < 20 || (kind != "site" && kind != "settings") || (kind == "site" && !domains.Contains(site)))
                throw new InvalidOperationException("解锁请求无效。");
            if (!challenges.ContainsKey(id)) {
                if (challenges.Count >= 256) throw new InvalidOperationException("未完成的解锁流程过多，请稍后重试。");
                challenges[id] = new Challenge { Kind = kind, Site = site, Stage = "questions", Created = Now };
            }
            var c = challenges[id];
            if (c.Kind != kind || c.Site != site) throw new InvalidOperationException("解锁目标不一致。");
            return Info(c);
        }
        if (command == "prepare-uninstall") {
            if (manageUntil <= Now) throw new InvalidOperationException("请先在扩展中点击‘解锁删改’，完成问题、打字和等待后再运行卸载程序。");
            RemoveHosts();
            preparedForRemoval = true;
            return new { ready = true, protocol = Protocol };
        }
        string ticket = Text(request, "id");
        if (command == "cancel") {
            challenges.Remove(ticket);
            return new { canceled = true, protocol = Protocol };
        }
        if (!challenges.ContainsKey(ticket)) throw new InvalidOperationException("系统保护流程已失效，请重新开始。");
        Challenge challenge = challenges[ticket];
        if (command == "answer") {
            int index;
            string text = Text(request, "text").Trim();
            if (!Int32.TryParse(Text(request, "index"), out index) || challenge.Stage != "questions" ||
                index != challenge.QuestionIndex || index < 0 || index >= QuestionMinimums.Length ||
                text.Length < QuestionMinimums[index] || text.Length > 500)
                throw new InvalidOperationException("请按顺序逐题回答，不能跳过问题。");
            // Store the cursor only. Answer content is not retained by the service.
            challenge.QuestionIndex++;
            if (challenge.QuestionIndex == QuestionMinimums.Length) challenge.Stage = "typing";
            return Info(challenge);
        }
        if (command == "edit-answer") {
            int index;
            string text = Text(request, "text").Trim();
            if (!Int32.TryParse(Text(request, "index"), out index) || index < 0 || index >= challenge.QuestionIndex ||
                text.Length < QuestionMinimums[index] || text.Length > 500)
                throw new InvalidOperationException("只能修改已经作答的题目。");
            if (challenge.Stage == "waiting") {
                challenge.Stage = "typing";
                challenge.Ready = 0;
            }
            return Info(challenge);
        }
        if (command == "typed") {
            if (challenge.Stage != "typing" || challenge.QuestionIndex != QuestionMinimums.Length || Text(request, "text") != Passage || !Flag(request, "manual"))
                throw new InvalidOperationException("请手动把原文中所有“你”换成“我”，其余文字和标点保持一致。");
            challenge.Stage = "waiting";
            challenge.Ready = Now + 5 * 60 * 1000;
            return Info(challenge);
        }
        if (command == "enter") {
            if (challenge.Stage != "waiting" || challenge.QuestionIndex != QuestionMinimums.Length || challenge.Ready > Now) throw new InvalidOperationException("系统保护：还没有完成全部问题和 5 分钟等待。");
            if (challenge.Kind == "site") {
                if (!domains.Contains(challenge.Site)) throw new InvalidOperationException("网站名单已改变，请重新开始。");
                var related = (challenge.Site == "x.com" || challenge.Site == "twitter.com")
                    ? domains.Where(site => site == "x.com" || site == "twitter.com").ToArray() : new[] { challenge.Site };
                foreach (string site in related) grants[site] = Now + 10 * 60 * 1000;
                try { WriteHosts(); }
                catch { foreach (string site in related) grants.Remove(site); throw; }
                Schedule();
            } else manageUntil = Now + 10 * 60 * 1000;
            challenges.Remove(ticket);
            return new { until = EpochAfter(10 * 60 * 1000), protocol = Protocol };
        }
        throw new InvalidOperationException("不支持的操作。");
    }
    private static string Text(Dictionary<string, object> value, string key) {
        object item; return value.TryGetValue(key, out item) && item != null ? Convert.ToString(item) : "";
    }
    private static bool Flag(Dictionary<string, object> value, string key) {
        object item; return value.TryGetValue(key, out item) && item is bool && (bool)item;
    }
    private static double EpochAfter(long milliseconds) {
        return (DateTime.UtcNow - new DateTime(1970, 1, 1)).TotalMilliseconds + Math.Max(0, milliseconds);
    }
    private static object Info(Challenge challenge) {
        return new { stage = challenge.Stage, readyAt = challenge.Ready == 0 ? 0 : EpochAfter(challenge.Ready - Now), questionIndex = challenge.QuestionIndex, protocol = Protocol };
    }
    private void Prune() {
        bool changed = false;
        foreach (string site in grants.Where(pair => pair.Value <= Now || !domains.Contains(pair.Key)).Select(pair => pair.Key).ToArray()) {
            grants.Remove(site); changed = true;
        }
        foreach (string id in challenges.Where(pair => Now - pair.Value.Created > 86400000).Select(pair => pair.Key).ToArray()) challenges.Remove(id);
        if (changed) { WriteHosts(); Schedule(); }
    }
    private void OnExpiry(object value) {
        lock (gate) {
            if (stopping || preparedForRemoval) return;
            try { Prune(); WriteHosts(); Schedule(); }
            catch (Exception error) {
                EventLog.WriteEntry(ServiceName, error.Message, EventLogEntryType.Error);
                // Retry only when an actual hosts update failed; there is no periodic idle work.
                expiry.Change(30000, Timeout.Infinite);
            }
        }
    }
    private void Schedule() {
        if (expiry == null) return;
        long due = grants.Count == 0 ? Timeout.Infinite : Math.Max(1, grants.Values.Min() - Now);
        expiry.Change(due, Timeout.Infinite);
    }
    private void SaveConfig() {
        File.WriteAllText(configPath, json.Serialize(domains), new UTF8Encoding(false));
    }
    private static List<string> Normalize(List<string> source) {
        if (source == null || source.Count > 200) throw new InvalidOperationException("网站名单无效。");
        var result = new List<string>();
        foreach (string raw in source) {
            string host = (raw ?? "").Trim().ToLowerInvariant();
            if (host.Length > 253 || !host.Contains(".") || host.Split('.').Any(part => !Regex.IsMatch(part, "^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")))
                throw new InvalidOperationException("网站域名无效：" + host);
            if (!result.Contains(host)) result.Add(host);
        }
        result.Sort(StringComparer.Ordinal);
        return result;
    }
    private string WithoutManagedEntries(string text) {
        int start = text.IndexOf(StartMarker, StringComparison.Ordinal);
        if (start < 0) return text;
        int end = text.IndexOf(EndMarker, start, StringComparison.Ordinal);
        if (end < 0) throw new IOException("hosts 文件保护标记不完整，请手动检查。");
        end += EndMarker.Length;
        if (end < text.Length && text[end] == '\r') end++;
        if (end < text.Length && text[end] == '\n') end++;
        return text.Remove(start, end - start);
    }
    private void WriteHosts() {
        string original = File.Exists(hostsPath) ? File.ReadAllText(hostsPath) : "";
        string backup = Path.Combine(Program.DataDirectory, "hosts-before-install.txt");
        if (!File.Exists(backup)) File.WriteAllText(backup, original, new UTF8Encoding(false));
        string clean = WithoutManagedEntries(original);
        var text = new StringBuilder(clean.TrimEnd('\r', '\n'));
        text.AppendLine(); text.AppendLine(StartMarker);
        foreach (string site in domains) {
            long until;
            if (grants.TryGetValue(site, out until) && until > Now) continue;
            foreach (string host in new[] { site, "www." + site, "m." + site, "mobile." + site }) {
                text.AppendLine("127.0.0.1 " + host);
                text.AppendLine("::1 " + host);
            }
        }
        text.AppendLine(EndMarker);
        WriteIfChanged(original, text.ToString());
    }
    private void RemoveHosts() {
        if (!File.Exists(hostsPath)) return;
        string original = File.ReadAllText(hostsPath);
        WriteIfChanged(original, WithoutManagedEntries(original));
    }
    private void WriteIfChanged(string original, string next) {
        if (original == next) return;
        File.WriteAllText(hostsPath, next, new UTF8Encoding(false));
        DnsFlushResolverCache();
    }
    private sealed class Challenge {
        internal string Kind, Site, Stage;
        internal long Created, Ready;
        internal int QuestionIndex;
    }
}
