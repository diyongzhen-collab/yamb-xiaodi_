# yamb 唯一启动脚本：双击运行。
# 职责：UTF-8 编码、自动用 Windows Terminal 承载（TUI 界面需要）、关闭 QuickEdit、启动 bot。

Set-Location -LiteralPath $PSScriptRoot

# ========== 1. UTF-8（最先设置，避免中文/emoji 乱码） ==========
try {
  $OutputEncoding = [System.Text.Encoding]::UTF8
  [Console]::InputEncoding = [System.Text.Encoding]::UTF8
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  chcp 65001 > $null
} catch {
  Write-Warning 'UTF-8 设置失败，中文/emoji 可能显示乱码'
}

# ========== 2. 自动用 Windows Terminal 承载（TUI 界面在 WT 中渲染才正常） ==========
# 已处于 WT 会话（$env:WT_SESSION 非空）时不重复打开。
if (-not $env:WT_SESSION) {
  $wtExe = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\wt.exe'
  if (-not [System.IO.File]::Exists($wtExe)) {
    $wtCmd = Get-Command wt.exe -ErrorAction SilentlyContinue
    if ($wtCmd) { $wtExe = $wtCmd.Source }
  }

  if ([System.IO.File]::Exists($wtExe)) {
    try {
      # 用系统自带的 Windows PowerShell 承载（无需额外安装 pwsh）。
      Start-Process -FilePath $wtExe -ArgumentList @(
        'powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass',
        '-File', "`"$PSCommandPath`""
      )
      exit
    } catch {
      Write-Warning '无法启动 Windows Terminal，退回当前控制台继续。'
    }
  } else {
    Write-Warning '未检测到 Windows Terminal（wt.exe）。TUI 界面在当前控制台下可能显示异常。'
  }
}

# ========== 3. 关闭 QuickEdit（老控制台下鼠标选中会冻结输出导致心跳超时） ==========
try {
  $sig = @'
[DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr GetStdHandle(int n);
[DllImport("kernel32.dll", SetLastError = true)] public static extern bool GetConsoleMode(IntPtr h, out uint m);
[DllImport("kernel32.dll", SetLastError = true)] public static extern bool SetConsoleMode(IntPtr h, uint m);
'@
  if (-not ('Win32.ConsoleMode' -as [type])) {
    Add-Type -MemberDefinition $sig -Name ConsoleMode -Namespace Win32
  }
  $h = [Win32.ConsoleMode]::GetStdHandle(-11)
  $m = [uint32]0
  if ([Win32.ConsoleMode]::GetConsoleMode($h, [ref]$m)) {
    $new = ($m -band (-bnot 0x40)) -bor 0x80
    [Win32.ConsoleMode]::SetConsoleMode($h, $new) | Out-Null
  }
} catch {
  # Windows Terminal 或非交互环境下忽略
}

# ========== 4. 项目完整性检查 ==========
if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'package.json'))) {
  Write-Error "未找到 package.json，请确认 start.ps1 位于 yamb 项目根目录：$PSScriptRoot"
  Read-Host 'Press Enter to close'
  exit 1
}
if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'node_modules'))) {
  Write-Warning '未检测到 node_modules，首次运行请先执行：yarn install'
}

# ========== 5. 自动启用 TUI 界面 ==========
# blessed 已安装且 .env 未显式设置 TUI_ENABLED 时，双击即进界面模式；
# 想关闭界面，在 .env 写 TUI_ENABLED=false 即可。
$blessedInstalled = Test-Path -LiteralPath (Join-Path $PSScriptRoot 'node_modules\blessed')
$envLines = Get-Content -LiteralPath (Join-Path $PSScriptRoot '.env') -ErrorAction SilentlyContinue
$envTuiSet = [bool]($envLines -match '^\s*TUI_ENABLED\s*=')
if ($blessedInstalled -and -not $envTuiSet) {
  $env:TUI_ENABLED = 'true'
  Write-Host '[start] 已自动启用 TUI 界面（在 .env 设置 TUI_ENABLED=false 可关闭）'
}

# ========== 5.5 AstrBot API 端口预检 ==========
# 端口被占用时提前提示（多为上一个 bot 进程未完全退出），仅提示不阻断启动。
try {
  $astrbotEnabled = $envLines | Where-Object { $_ -match '^\s*ASTRBOT_ENABLED\s*=' } | ForEach-Object { ($_ -split '=', 2)[1].Trim() }
  if ($astrbotEnabled -match 'true') {
    $apiPortLine = $envLines | Where-Object { $_ -match '^\s*API_PORT\s*=' } | ForEach-Object { ($_ -split '=', 2)[1].Trim() }
    $apiPort = if ($apiPortLine) { [int]$apiPortLine } else { 15100 }
    $listener = Get-NetTCPConnection -LocalPort $apiPort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($listener) {
      $proc = Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue
      Write-Warning "[start] 端口 ${apiPort} 已被占用（PID=$($listener.OwningProcess) $($proc.ProcessName)），AstrBot/QQ 接口将启动失败。"
      Write-Warning '[start] 若为上一个 bot 残留进程，请先在任务管理器结束 node.exe 再启动；也可修改 .env 的 API_PORT。'
    }
  }
} catch {
  # 预检失败（如精简系统无 Get-NetTCPConnection）不阻断启动，交由 bot 内部处理。
}

# ========== 6. 启动 bot ==========
try {
  & yarn start
  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0) {
    Write-Warning "yarn start 退出码: $exitCode（异常退出，日志见 logs/ 目录）"
  }
} catch {
  Write-Error "启动失败: $($_.Exception.Message)"
  Write-Warning '请确认已执行 yarn install 且网络正常。'
} finally {
  try {
    Read-Host 'Press Enter to close'
  } catch {
    # 非交互环境（如计划任务）下忽略
  }
}
