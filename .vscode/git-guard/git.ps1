param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Args
)

if ($Args -contains 'restore') {
  Write-Error 'git restore is blocked in this workspace. Use git diff and apply_patch instead.'
  exit 1
}

& 'C:\Program Files\Git\cmd\git.exe' @Args
exit $LASTEXITCODE
