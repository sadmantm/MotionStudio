// desktop/bootstrap/MotionStudio.cs
//
//  "Motion Studio.exe" (Windows): abrir o app direto de um clone do GitHub,
//  sem instalar nada antes. Compilado pelo csc do .NET Framework 4 que vem
//  no Windows 10/11 (npm run desktop:bootstrap) — C# 5, sem dependências, ~30 KB,
//  versionado no repositório. Na 1ª abertura (e quando o package.json muda):
//
//    1. Node.js  — usa o do sistema (>= 20) ou baixa o portátil
//    2. Pacotes  — npm install (o postinstall baixa o FFmpeg; o puppeteer, o Chrome do export)
//    3. FFmpeg   — confere .bin/ffmpeg e baixa de novo se o postinstall falhou
//    4. Python   — para a transcrição: usa o do sistema (>= 3.10) ou baixa o
//                  portátil (o Whisper se instala sozinho depois)
//    5. Abre desktop/launcher.js (servidor + janela do editor) e espera ele fechar
//  Node e Python portáteis ficam em %LOCALAPPDATA%\Motion Studio\runtime: caminho
//  curto e fixo (dentro de uma pasta longa, as pastas do npm passam de 260 caracteres).
//
//  Qualquer falha abre uma janela com o código do erro (tabela em ERRORS),
//  os detalhes e o log. Log desta etapa: %LOCALAPPDATA%\Motion Studio\logs\setup.log

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

[assembly: System.Reflection.AssemblyTitle("Motion Studio")]
[assembly: System.Reflection.AssemblyProduct("Motion Studio")]
[assembly: System.Reflection.AssemblyVersion("1.0.0.0")]

namespace MotionStudio
{
    /// <summary>Falha com código para o usuário (e para quem for ajudar)</summary>
    class SetupError : Exception
    {
        public readonly string Code;
        public readonly string Detail;
        public SetupError(string code, string message, string detail) : base(message)
        {
            Code = code;
            Detail = detail ?? "";
        }
    }

    static class Program
    {
        const string NodeVersion = "v22.22.0";   // portátil, se o sistema não tiver Node >= NodeMinMajor
        const int NodeMinMajor = 20;
        const string PythonMinor = "3.12";

        /// <summary>Códigos de erro (também em desktop/bootstrap/README.md)</summary>
        public static readonly Dictionary<string, string> ERRORS = new Dictionary<string, string>
        {
            { "MS-101", "Pasta do Motion Studio incompleta" },
            { "MS-102", "Sem permissão de escrita na pasta do Motion Studio" },
            { "MS-201", "Falha ao baixar o Node.js" },
            { "MS-202", "Falha ao extrair o Node.js" },
            { "MS-203", "O Node.js não executa neste computador" },
            { "MS-301", "Falha ao instalar os pacotes (npm install)" },
            { "MS-302", "Pacotes incompletos depois da instalação" },
            { "MS-501", "Python para a transcrição não foi baixado" },
            { "MS-502", "tar.exe não encontrado (Windows antigo)" },
            { "MS-610", "Nenhum navegador compatível (Chrome, Edge ou Firefox)" },
            { "MS-620", "Nenhuma porta de rede livre" },
            { "MS-630", "O servidor do Motion Studio não iniciou" },
            { "MS-631", "O servidor do Motion Studio não respondeu" },
            { "MS-640", "O navegador não abriu" },
            { "MS-699", "O Motion Studio fechou com erro" },
            { "MS-900", "Erro inesperado na preparação" },
        };

        static string appDir;
        static string dataDir;
        static string runtimeDir;   // Node e Python portáteis
        static string pythonBase;   // Python portátil → WHISPER_BASE_PYTHON do launcher
        static string logDir;
        static string setupLog;
        static SetupForm form;
        static volatile bool cancelled;
        static Process current;   // processo filho em andamento (cancelar mata a árvore)

        [STAThread]
        static int Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            // nodejs.org e GitHub exigem TLS 1.2 (o padrão do .NET 4 pode ser mais antigo)
            ServicePointManager.SecurityProtocol |= (SecurityProtocolType)3072;

            dataDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Motion Studio");
            string custom = Environment.GetEnvironmentVariable("MS_DATA_DIR");
            if (!string.IsNullOrEmpty(custom)) dataDir = custom;
            logDir = Path.Combine(dataDir, "logs");
            runtimeDir = Path.Combine(dataDir, "runtime");
            try
            {
                Directory.CreateDirectory(logDir);
                setupLog = Path.Combine(logDir, "setup.log");
                if (File.Exists(setupLog) && new FileInfo(setupLog).Length > 2000000) File.Delete(setupLog);
            }
            catch (Exception) { setupLog = null; }

            form = new SetupForm();
            // Handle criado aqui (thread da interface): a thread de trabalho usa Invoke nele
            IntPtr handle = form.Handle;
            form.FormClosing += delegate(object s, FormClosingEventArgs e)
            {
                if (e.CloseReason != CloseReason.UserClosing || form.Finished) return;
                cancelled = true;
                KillCurrent();
            };

            int exitCode = 0;
            var context = new ApplicationContext();
            var worker = new Thread(delegate()
            {
                exitCode = Run();
                form.Finished = true;
                UI(delegate { form.Close(); context.ExitThread(); });
            });
            worker.IsBackground = true;
            worker.Start();
            Application.Run(context);
            return exitCode;
        }

        /// <summary>Fluxo inteiro (thread de trabalho). Devolve o código de saída do processo.</summary>
        static int Run()
        {
            try
            {
                Log("==== " + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " · " + Environment.OSVersion + " · " + Arch());
                appDir = FindAppDir();
                Log("app: " + appDir);
                CheckWritable();

                string node = EnsureNode();
                EnsurePackages(node);
                EnsureFfmpeg(node);
                if (cancelled) return 1;
                EnsurePython();
                if (cancelled) return 1;
                return Launch(node);
            }
            catch (SetupError e)
            {
                Log("ERRO " + e.Code + ": " + e.Message + "\n" + e.Detail);
                if (!cancelled) ShowError(e.Code, e.Message, e.Detail, false);
                return 1;
            }
            catch (Exception e)
            {
                Log("ERRO MS-900: " + e);
                if (!cancelled) ShowError("MS-900", "Erro inesperado: " + e.Message, e.ToString(), false);
                return 1;
            }
        }

        // ── Pasta do app ─────────────────────────────────────────────────────
        static bool IsApp(string dir)
        {
            return File.Exists(Path.Combine(dir, "index.js"))
                && File.Exists(Path.Combine(dir, "package.json"))
                && File.Exists(Path.Combine(dir, "desktop", "launcher.js"));
        }

        static string FindAppDir()
        {
            string env = Environment.GetEnvironmentVariable("MS_APP_DIR");
            if (!string.IsNullOrEmpty(env) && IsApp(env)) return Path.GetFullPath(env);
            for (var dir = new DirectoryInfo(AppDomain.CurrentDomain.BaseDirectory); dir != null; dir = dir.Parent)
            {
                if (IsApp(dir.FullName)) return dir.FullName;
            }
            throw new SetupError("MS-101",
                "Não encontrei os arquivos do Motion Studio (index.js, package.json, desktop\\launcher.js).",
                "Deixe o \"Motion Studio.exe\" na pasta do projeto baixado do GitHub (ou crie um atalho para ele).\nPasta do executável: " + AppDomain.CurrentDomain.BaseDirectory);
        }

        static void CheckWritable()
        {
            string probe = Path.Combine(appDir, ".ms-write-test");
            try
            {
                File.WriteAllText(probe, "ok");
                File.Delete(probe);
            }
            catch (Exception e)
            {
                throw new SetupError("MS-102",
                    "A pasta do Motion Studio está protegida contra escrita.",
                    "Mova a pasta para Documentos ou Área de Trabalho (fora de \"Arquivos de Programas\").\n" + appDir + "\n" + e.Message);
            }
        }

        // ── Node.js ──────────────────────────────────────────────────────────
        static string NpmCli(string node)
        {
            return Path.Combine(Path.GetDirectoryName(node), "node_modules", "npm", "bin", "npm-cli.js");
        }

        /// <summary>Major da versão (node -v) ou 0 se não executa</summary>
        static int NodeMajor(string node)
        {
            string output;
            if (Exec(node, "-v", appDir, 15000, out output) != 0) return 0;
            var m = Regex.Match(output, @"v(\d+)\.");
            return m.Success ? int.Parse(m.Groups[1].Value) : 0;
        }

        static string FindOnPath(string exe)
        {
            string path = Environment.GetEnvironmentVariable("PATH") ?? "";
            foreach (string dir in path.Split(';'))
            {
                if (dir.Trim().Length == 0) continue;
                try
                {
                    string candidate = Path.Combine(dir.Trim().Trim('"'), exe);
                    if (File.Exists(candidate)) return candidate;
                }
                catch (ArgumentException) { /* entrada inválida no PATH */ }
            }
            return null;
        }

        static string EnsureNode()
        {
            string portableDir = Path.Combine(runtimeDir, "node-" + NodeVersion);
            string portable = Path.Combine(portableDir, "node.exe");
            if (File.Exists(portable) && File.Exists(NpmCli(portable)) && NodeMajor(portable) >= NodeMinMajor) return portable;

            string system = FindOnPath("node.exe");
            if (system != null && File.Exists(NpmCli(system)))
            {
                int major = NodeMajor(system);
                Log("Node do sistema: " + system + " (major " + major + ")");
                if (major >= NodeMinMajor) return system;
            }

            // Baixa o Node portátil (só para o Motion Studio: não mexe no sistema)
            Step("Baixando o Node.js " + NodeVersion + "…", 0);
            string arch = Arch() == "arm64" ? "arm64" : "x64";
            string name = "node-" + NodeVersion + "-win-" + arch;
            string url = "https://nodejs.org/dist/" + NodeVersion + "/" + name + ".zip";
            string zip = Path.Combine(Path.GetTempPath(), name + ".zip");
            Download(url, zip, "MS-201", "Baixando o Node.js");

            Step("Extraindo o Node.js…", -1);
            string tmp = portableDir + ".tmp";
            try
            {
                if (Directory.Exists(tmp)) Directory.Delete(tmp, true);
                ZipFile.ExtractToDirectory(zip, tmp);
                if (Directory.Exists(portableDir)) Directory.Delete(portableDir, true);
                Directory.CreateDirectory(Path.GetDirectoryName(portableDir));
                Directory.Move(Path.Combine(tmp, name), portableDir);
                Directory.Delete(tmp, true);
                File.Delete(zip);
            }
            catch (Exception e)
            {
                throw new SetupError("MS-202", "Não consegui extrair o Node.js.", url + "\n" + e.Message);
            }
            if (NodeMajor(portable) < NodeMinMajor)
            {
                throw new SetupError("MS-203", "O Node.js baixado não executou neste computador.",
                    portable + "\nO antivírus pode ter bloqueado o arquivo.");
            }
            Log("Node portátil: " + portable);
            return portable;
        }

        // ── Pacotes (npm install) ────────────────────────────────────────────
        /// <summary>Hash do package.json + package-lock.json: mudou = instalar de novo</summary>
        static string DepsHash()
        {
            using (var sha = SHA1.Create())
            {
                var bytes = new List<byte>();
                foreach (string f in new[] { "package.json", "package-lock.json" })
                {
                    string p = Path.Combine(appDir, f);
                    if (File.Exists(p)) bytes.AddRange(File.ReadAllBytes(p));
                }
                return BitConverter.ToString(sha.ComputeHash(bytes.ToArray())).Replace("-", "");
            }
        }

        static void EnsurePackages(string node)
        {
            string modules = Path.Combine(appDir, "node_modules");
            string marker = Path.Combine(modules, ".motion-studio-deps");
            string hash = DepsHash();
            bool ok = Directory.Exists(Path.Combine(modules, "express"))
                && File.Exists(marker) && File.ReadAllText(marker).Trim() == hash;
            if (ok) return;

            Step("Instalando os pacotes do Motion Studio (1ª vez: alguns minutos)…", -1);
            var tail = new Tail(40);
            int code = RunLogged(node, Quote(NpmCli(node)) + " install --no-audit --no-fund --loglevel=http", node, delegate(string line)
            {
                tail.Add(line);
                Detail(line);
            });
            if (cancelled) return;
            if (code != 0)
            {
                throw new SetupError("MS-301", "A instalação dos pacotes falhou (npm install, código " + code + ").",
                    "Confira a conexão com a internet e tente de novo.\n\nÚltimas linhas:\n" + tail);
            }
            if (!Directory.Exists(Path.Combine(modules, "express")))
            {
                throw new SetupError("MS-302", "Os pacotes não ficaram completos depois da instalação.", tail.ToString());
            }
            File.WriteAllText(marker, hash);
        }

        /// <summary>O postinstall baixa o FFmpeg com --optional (falha só avisa): confere e tenta de novo</summary>
        static void EnsureFfmpeg(string node)
        {
            if (cancelled || File.Exists(Path.Combine(appDir, ".bin", "ffmpeg", "ffmpeg.exe"))) return;
            Step("Baixando o FFmpeg…", -1);
            int code = RunLogged(node, Quote(Path.Combine(appDir, "desktop", "ffmpeg.js")), node, delegate(string line) { Detail(line); });
            // Sem ele o app usa o ffmpeg-static dos pacotes (mais antigo): não impede de abrir
            if (code != 0) Log("FFmpeg não baixado (código " + code + "): segue com o ffmpeg-static");
        }

        // ── Python (transcrição) ─────────────────────────────────────────────
        static bool SystemPythonOk()
        {
            foreach (var cand in new[] { new[] { "py", "-3 " }, new[] { "python", "" } })
            {
                string exe = FindOnPath(cand[0] + ".exe");
                // python.exe em WindowsApps é o atalho da Microsoft Store, não um Python
                if (exe == null || exe.IndexOf("WindowsApps", StringComparison.OrdinalIgnoreCase) >= 0) continue;
                string output;
                if (Exec(exe, cand[1] + "-c \"import sys;print(sys.version_info[0]*100+sys.version_info[1])\"", appDir, 15000, out output) != 0) continue;
                int v;
                if (int.TryParse(output.Trim(), out v) && v >= 310) return true;
            }
            return false;
        }

        static void EnsurePython()
        {
            string portable = Path.Combine(runtimeDir, "python", "python.exe");
            if (File.Exists(portable)) { pythonBase = portable; return; }
            if (File.Exists(Path.Combine(appDir, "runtime", "python", "python.exe"))) return;   // pacote do desktop:build
            if (File.Exists(Path.Combine(dataDir, "whisper-env", "Scripts", "python.exe")) || SystemPythonOk()) return;

            try
            {
                string tar = Path.Combine(Environment.SystemDirectory, "tar.exe");
                if (!File.Exists(tar)) throw new SetupError("MS-502", "Este Windows não tem o tar.exe para extrair o Python.", tar);

                Step("Procurando o Python " + PythonMinor + " portátil…", -1);
                string arch = Arch() == "arm64" ? "aarch64" : "x86_64";
                string json = HttpText("https://api.github.com/repos/astral-sh/python-build-standalone/releases/latest", "MS-501");
                var m = Regex.Match(json, "\"browser_download_url\"\\s*:\\s*\"([^\"]*cpython-" + Regex.Escape(PythonMinor) + "\\.\\d+(?:%2B|\\+)\\d+-" + arch + "-pc-windows-msvc-install_only\\.tar\\.gz)\"");
                if (!m.Success) throw new SetupError("MS-501", "Não achei o Python " + PythonMinor + " para " + arch + " no GitHub.", "python-build-standalone: release mais recente sem o arquivo esperado.");

                string archive = Path.Combine(Path.GetTempPath(), "ms-python-" + arch + ".tar.gz");
                Download(m.Groups[1].Value, archive, "MS-501", "Baixando o Python (transcrição)");

                Step("Extraindo o Python…", -1);
                string runtime = runtimeDir;
                Directory.CreateDirectory(runtime);
                string output;
                int code = Exec(tar, "-xzf " + Quote(archive) + " -C " + Quote(runtime), runtime, 600000, out output);
                File.Delete(archive);
                if (code != 0 || !File.Exists(Path.Combine(runtime, "python", "python.exe")))
                {
                    throw new SetupError("MS-501", "Não consegui extrair o Python.", output);
                }
                pythonBase = Path.Combine(runtime, "python", "python.exe");
                Log("Python portátil: " + pythonBase);
            }
            catch (SetupError e)
            {
                if (cancelled) return;
                // Só a transcrição depende dele: avisa e segue abrindo o app
                Log("AVISO " + e.Code + ": " + e.Message + "\n" + e.Detail);
                ShowError(e.Code, e.Message + "\n\nO Motion Studio abre normalmente; só a transcrição automática fica indisponível até o Python ser instalado (tenta de novo na próxima abertura).", e.Detail, true);
            }
        }

        // ── Abrir o app ──────────────────────────────────────────────────────
        static int Launch(string node)
        {
            Step("Abrindo o Motion Studio…", -1);
            string errorFile = Path.Combine(logDir, "last-error.json");
            try { File.Delete(errorFile); } catch (Exception) { }

            var psi = new ProcessStartInfo(node, Quote(Path.Combine(appDir, "desktop", "launcher.js")));
            psi.WorkingDirectory = appDir;
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            PrependPath(psi, Path.GetDirectoryName(node));
            psi.EnvironmentVariables["MS_APP_DIR"] = appDir;
            psi.EnvironmentVariables["MS_BOOTSTRAP"] = "1";
            if (pythonBase != null && string.IsNullOrEmpty(psi.EnvironmentVariables["WHISPER_BASE_PYTHON"]))
                psi.EnvironmentVariables["WHISPER_BASE_PYTHON"] = pythonBase;
            Log("abrindo: " + psi.FileName + " " + psi.Arguments);

            Process p;
            try { p = Process.Start(psi); }
            catch (Exception e) { throw new SetupError("MS-203", "O Node.js não executou.", node + "\n" + e.Message); }

            // A janela de preparação some quando o editor começa a abrir
            Thread.Sleep(1500);
            UI(delegate { form.Hide(); });
            p.WaitForExit();
            Log("launcher saiu com código " + p.ExitCode);
            if (p.ExitCode == 0) return 0;

            // O launcher grava o erro (código + mensagem) em logs/last-error.json
            string code = "MS-699", message = "O Motion Studio fechou com erro (código de saída " + p.ExitCode + ").";
            bool shown = false;
            try
            {
                string json = File.ReadAllText(errorFile, Encoding.UTF8);
                var c = Regex.Match(json, "\"code\"\\s*:\\s*\"([^\"]+)\"");
                var msg = Regex.Match(json, "\"message\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"");
                if (c.Success) code = c.Groups[1].Value;
                if (msg.Success) message = Regex.Unescape(msg.Groups[1].Value);
                shown = Regex.IsMatch(json, "\"shown\"\\s*:\\s*true");
            }
            catch (Exception) { /* sem arquivo: erro antes do launcher gravar */ }
            if (!shown) ShowError(code, message, LogTail(Path.Combine(logDir, "motion-studio.log"), 40), false);
            return p.ExitCode;
        }

        // ── Processos ────────────────────────────────────────────────────────
        static string Quote(string s) { return "\"" + s + "\""; }

        static void PrependPath(ProcessStartInfo psi, string dir)
        {
            string path = psi.EnvironmentVariables["PATH"] ?? "";
            psi.EnvironmentVariables["PATH"] = dir + ";" + path;
            // npm roda os scripts dos pacotes pelo ComSpec (cmd.exe): sem ele o install quebra
            if (string.IsNullOrEmpty(psi.EnvironmentVariables["ComSpec"]))
                psi.EnvironmentVariables["ComSpec"] = Path.Combine(Environment.SystemDirectory, "cmd.exe");
        }

        /// <summary>Roda e devolve a saída inteira (comandos curtos)</summary>
        static int Exec(string exe, string args, string cwd, int timeoutMs, out string output)
        {
            output = "";
            try
            {
                var psi = new ProcessStartInfo(exe, args);
                psi.WorkingDirectory = cwd;
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                psi.RedirectStandardOutput = true;
                psi.RedirectStandardError = true;
                using (var p = Process.Start(psi))
                {
                    var err = p.StandardError.ReadToEndAsync();
                    output = p.StandardOutput.ReadToEnd();
                    if (!p.WaitForExit(timeoutMs)) { try { p.Kill(); } catch (Exception) { } return -1; }
                    output += err.Result;
                    return p.ExitCode;
                }
            }
            catch (Exception e)
            {
                output = e.Message;
                return -1;
            }
        }

        /// <summary>Roda com a saída linha a linha no log (instalações demoradas). Cancelável.</summary>
        static int RunLogged(string node, string args, string nodePath, Action<string> onLine)
        {
            var psi = new ProcessStartInfo(node, args);
            psi.WorkingDirectory = appDir;
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            psi.StandardOutputEncoding = Encoding.UTF8;
            psi.StandardErrorEncoding = Encoding.UTF8;
            // Scripts do postinstall chamam "node": o mesmo que roda o npm
            PrependPath(psi, Path.GetDirectoryName(nodePath));
            psi.EnvironmentVariables["npm_config_update_notifier"] = "false";
            Log("> " + node + " " + args);
            DataReceivedEventHandler handler = delegate(object s, DataReceivedEventArgs e)
            {
                if (e.Data == null) return;
                Log("  " + e.Data);
                onLine(e.Data);
            };
            using (var p = new Process())
            {
                p.StartInfo = psi;
                p.OutputDataReceived += handler;
                p.ErrorDataReceived += handler;
                p.Start();
                current = p;
                p.BeginOutputReadLine();
                p.BeginErrorReadLine();
                p.WaitForExit();
                current = null;
                return cancelled ? -1 : p.ExitCode;
            }
        }

        static void KillCurrent()
        {
            var p = current;
            if (p == null) return;
            string output;
            // npm abre filhos (postinstall, download do Chrome): mata a árvore
            try { Exec("taskkill", "/PID " + p.Id + " /T /F", appDir, 10000, out output); } catch (Exception) { }
        }

        // ── Rede ─────────────────────────────────────────────────────────────
        static HttpWebRequest Request(string url)
        {
            var req = (HttpWebRequest)WebRequest.Create(url);
            req.UserAgent = "MotionStudio-Setup";
            req.Timeout = 30000;
            req.ReadWriteTimeout = 60000;
            req.AllowAutoRedirect = true;
            return req;
        }

        static string HttpText(string url, string code)
        {
            try
            {
                var req = Request(url);
                req.Accept = "application/vnd.github+json";
                using (var resp = req.GetResponse())
                using (var reader = new StreamReader(resp.GetResponseStream(), Encoding.UTF8))
                {
                    return reader.ReadToEnd();
                }
            }
            catch (Exception e)
            {
                throw new SetupError(code, "Sem conexão com " + new Uri(url).Host + ".", url + "\n" + e.Message);
            }
        }

        static void Download(string url, string dest, string code, string label)
        {
            Log("baixando " + url);
            string part = dest + ".part";
            try
            {
                var req = Request(url);
                using (var resp = (HttpWebResponse)req.GetResponse())
                using (var input = resp.GetResponseStream())
                using (var output = File.Create(part))
                {
                    long total = resp.ContentLength, done = 0;
                    var buffer = new byte[81920];
                    int read, lastPct = -1;
                    while ((read = input.Read(buffer, 0, buffer.Length)) > 0)
                    {
                        if (cancelled) throw new SetupError(code, "Cancelado.", "");
                        output.Write(buffer, 0, read);
                        done += read;
                        int pct = total > 0 ? (int)(done * 100 / total) : -1;
                        if (pct != lastPct)
                        {
                            lastPct = pct;
                            Step(label + (pct >= 0 ? "… " + pct + "%" : "…"), pct);
                            Detail((done / 1048576.0).ToString("0.0") + " MB" + (total > 0 ? " de " + (total / 1048576.0).ToString("0.0") + " MB" : ""));
                        }
                    }
                }
                if (File.Exists(dest)) File.Delete(dest);
                File.Move(part, dest);
            }
            catch (SetupError) { throw; }
            catch (Exception e)
            {
                try { File.Delete(part); } catch (Exception) { }
                throw new SetupError(code, "Falha no download (" + new Uri(url).Host + "). Confira a conexão com a internet.", url + "\n" + e.Message);
            }
        }

        // ── Utilidades ───────────────────────────────────────────────────────
        static string Arch()
        {
            string a = Environment.GetEnvironmentVariable("PROCESSOR_ARCHITEW6432") ?? Environment.GetEnvironmentVariable("PROCESSOR_ARCHITECTURE") ?? "";
            return a.ToUpperInvariant() == "ARM64" ? "arm64" : "x64";
        }

        static readonly object logLock = new object();
        static void Log(string line)
        {
            if (setupLog == null) return;
            lock (logLock)
            {
                try { File.AppendAllText(setupLog, line + Environment.NewLine, Encoding.UTF8); } catch (Exception) { }
            }
        }

        static string LogTail(string file, int lines)
        {
            try
            {
                string[] all = File.ReadAllLines(file, Encoding.UTF8);
                int from = Math.Max(0, all.Length - lines);
                return string.Join(Environment.NewLine, all, from, all.Length - from);
            }
            catch (Exception) { return "(log indisponível: " + file + ")"; }
        }

        class Tail
        {
            readonly Queue<string> lines = new Queue<string>();
            readonly int max;
            public Tail(int max) { this.max = max; }
            public void Add(string line)
            {
                lock (lines)
                {
                    lines.Enqueue(line);
                    while (lines.Count > max) lines.Dequeue();
                }
            }
            public override string ToString()
            {
                lock (lines) { return string.Join(Environment.NewLine, lines.ToArray()); }
            }
        }

        // ── Interface ────────────────────────────────────────────────────────
        static void UI(MethodInvoker action)
        {
            if (form.InvokeRequired) form.Invoke(action);
            else action();
        }

        /// <summary>Etapa na janela de preparação (que só aparece quando há algo a fazer). pct -1 = indeterminado</summary>
        static void Step(string text, int pct)
        {
            Log("[etapa] " + text);
            UI(delegate
            {
                form.SetStep(text, pct);
                if (!form.Visible) form.Show();
            });
        }

        static void Detail(string text)
        {
            UI(delegate { form.SetDetail(text); });
        }

        static void ShowError(string code, string message, string detail, bool warning)
        {
            string title;
            if (!ERRORS.TryGetValue(code, out title)) title = "Erro";
            UI(delegate
            {
                form.Hide();
                using (var dlg = new ErrorForm(code, title, message, detail, logDir, warning))
                {
                    dlg.ShowDialog();
                }
            });
        }
    }

    /// <summary>Janela "Preparando o Motion Studio"</summary>
    class SetupForm : Form
    {
        public volatile bool Finished;
        readonly Label step = new Label();
        readonly Label detail = new Label();
        readonly ProgressBar bar = new ProgressBar();

        public SetupForm()
        {
            Text = "Motion Studio";
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = true;
            StartPosition = FormStartPosition.CenterScreen;
            ClientSize = new Size(480, 170);
            Font = new Font("Segoe UI", 9f);
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch (Exception) { }

            var title = new Label { Text = "Preparando o Motion Studio", Font = new Font("Segoe UI", 12f, FontStyle.Bold), AutoSize = true, Location = new Point(20, 16) };
            step.SetBounds(20, 52, 440, 20);
            bar.SetBounds(20, 76, 440, 18);
            bar.Style = ProgressBarStyle.Marquee;
            detail.SetBounds(20, 100, 440, 18);
            detail.ForeColor = SystemColors.GrayText;
            detail.AutoEllipsis = true;
            var hint = new Label { Text = "Só na primeira vez (ou depois de uma atualização). Pode levar alguns minutos.", AutoSize = false, ForeColor = SystemColors.GrayText };
            hint.SetBounds(20, 132, 440, 20);
            Controls.AddRange(new Control[] { title, step, bar, detail, hint });
        }

        public void SetStep(string text, int pct)
        {
            step.Text = text;
            if (pct < 0) { bar.Style = ProgressBarStyle.Marquee; }
            else { bar.Style = ProgressBarStyle.Continuous; bar.Value = Math.Max(0, Math.Min(100, pct)); }
            detail.Text = "";
        }

        public void SetDetail(string text) { detail.Text = text; }
    }

    /// <summary>Janela de erro: código, mensagem, detalhes e atalhos para o log</summary>
    class ErrorForm : Form
    {
        public ErrorForm(string code, string title, string message, string detail, string logDir, bool warning)
        {
            Text = "Motion Studio — " + (warning ? "aviso" : "erro") + " " + code;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            ClientSize = new Size(600, 420);
            Font = new Font("Segoe UI", 9f);
            TopMost = true;
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch (Exception) { }

            var icon = new PictureBox { Image = (warning ? SystemIcons.Warning : SystemIcons.Error).ToBitmap(), SizeMode = PictureBoxSizeMode.AutoSize, Location = new Point(20, 20) };
            var head = new Label { Text = warning ? "Aviso ao preparar o Motion Studio" : "Não foi possível iniciar o Motion Studio", Font = new Font("Segoe UI", 12f, FontStyle.Bold), AutoSize = true, Location = new Point(64, 18) };
            var codeLabel = new Label { Text = "Código " + code + " · " + title, Font = new Font("Segoe UI", 10f, FontStyle.Bold), ForeColor = warning ? Color.DarkGoldenrod : Color.Firebrick, AutoSize = true, Location = new Point(64, 46) };
            var text = new Label { Text = message, AutoSize = false, Location = new Point(64, 72) };
            text.Size = new Size(516, 64);
            var box = new TextBox
            {
                Multiline = true,
                ReadOnly = true,
                ScrollBars = ScrollBars.Both,
                WordWrap = false,
                Font = new Font("Consolas", 8.5f),
                Text = (detail ?? "").Replace("\r\n", "\n").Replace("\n", Environment.NewLine),
                Location = new Point(20, 144),
                Size = new Size(560, 216),
            };

            var copy = new Button { Text = "Copiar detalhes", Location = new Point(20, 376), Size = new Size(120, 28) };
            copy.Click += delegate
            {
                try { Clipboard.SetText("Motion Studio " + code + " — " + title + Environment.NewLine + message + Environment.NewLine + Environment.NewLine + box.Text); } catch (Exception) { }
            };
            var logs = new Button { Text = "Abrir pasta de logs", Location = new Point(148, 376), Size = new Size(130, 28) };
            logs.Click += delegate { try { Process.Start("explorer.exe", "\"" + logDir + "\""); } catch (Exception) { } };
            Controls.AddRange(new Control[] { icon, head, codeLabel, text, box, copy, logs });

            if (warning)
            {
                var go = new Button { Text = "Continuar", Location = new Point(480, 376), Size = new Size(100, 28), DialogResult = DialogResult.OK };
                Controls.Add(go);
                AcceptButton = go;
                ActiveControl = go;
            }
            else
            {
                var retry = new Button { Text = "Tentar de novo", Location = new Point(370, 376), Size = new Size(104, 28), DialogResult = DialogResult.Retry };
                retry.Click += delegate { try { Process.Start(Application.ExecutablePath); } catch (Exception) { } };
                var close = new Button { Text = "Fechar", Location = new Point(480, 376), Size = new Size(100, 28), DialogResult = DialogResult.Cancel };
                Controls.Add(retry);
                Controls.Add(close);
                AcceptButton = close;
                CancelButton = close;
                ActiveControl = close;   // sem foco na caixa de detalhes (abriria todo selecionado)
            }
        }
    }
}
