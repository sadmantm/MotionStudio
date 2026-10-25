using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

class Program
{
    static void Main()
    {
        string pastaProjeto = AppDomain.CurrentDomain.BaseDirectory;

        string gitBash = @"C:\Program Files\Git\git-bash.exe";
        string startSh = Path.Combine(pastaProjeto, "start.sh");

        if (!File.Exists(gitBash))
        {
            MessageBox.Show($"Git Bash não encontrado em:\n{gitBash}", "Erro");
            return;
        }

        if (!File.Exists(startSh))
        {
            MessageBox.Show($"start.sh não encontrado em:\n{startSh}", "Erro");
            return;
        }

        string pastaGitBash = pastaProjeto.TrimEnd('\\').Replace("\\", "/");

        try
        {
            Process.Start(new ProcessStartInfo
            {
                FileName = gitBash,
                Arguments = $"--cd=\"{pastaGitBash}\" -c \"./start.sh\"",
                UseShellExecute = true
            });
        }
        catch (System.Exception ex)
        {
            MessageBox.Show($"Falha ao iniciar o Git Bash:\n{ex.Message}", "Erro");
        }
    }
}