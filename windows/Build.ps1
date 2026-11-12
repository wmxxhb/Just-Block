$ErrorActionPreference = 'Stop'
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { throw '需要 Windows .NET Framework 4.x 编译器。' }
$source = Join-Path $PSScriptRoot 'JustBlock.cs'
$output = Join-Path $PSScriptRoot 'JustBlock.exe'
$shared = [IO.File]::ReadAllText((Join-Path $PSScriptRoot '..\shared.js'), [Text.Encoding]::UTF8)
$passage = [regex]::Match($shared, 'export const PASSAGE = "([^"]+)";').Groups[1].Value
if ($passage.Length -ne 200) { throw '固定文字必须为 200 字（含标点）。' }
# The displayed source keeps 你; the required keyboard input uses 我 throughout.
$passage = $passage.Replace('你', '我')
$code = [IO.File]::ReadAllText($source, [Text.Encoding]::UTF8)
$code = [regex]::Replace($code, 'private const string Passage = "[^"]*";', ('private const string Passage = "' + $passage + '";'))
$minimums = @([regex]::Matches($shared, 'minimum:\s*(\d+)') | ForEach-Object { $_.Groups[1].Value }) -join ', '
$code = [regex]::Replace($code, 'private static readonly int\[\] QuestionMinimums = new int\[\] \{[^}]+\};', ('private static readonly int[] QuestionMinimums = new int[] { ' + $minimums + ' };'))
[IO.File]::WriteAllText($source, $code, (New-Object Text.UTF8Encoding($true)))
& $compiler /nologo /target:exe /platform:anycpu /optimize+ /reference:System.ServiceProcess.dll /reference:System.Web.Extensions.dll /out:$output $source
if ($LASTEXITCODE -ne 0) { throw '编译未完成。' }
