# Snapshot file
# Unset all aliases to avoid conflicts with functions
unalias -a 2>/dev/null || true
shopt -s expand_aliases
# Check for rg availability
if ! (unalias rg 2>/dev/null; command -v rg) >/dev/null 2>&1; then
  alias rg='/opt/polsia/node_modules/\@anthropic-ai/claude-agent-sdk/vendor/ripgrep/x64-linux/rg'
fi
export PATH=/opt/render/project/nodes/node-26.0.0/bin\:/opt/render/project/src/node_modules/.bin\:/opt/render/project/src/.venv/bin\:/opt/render/project/bun/bin\:/home/render/.bun/bin\:/usr/local/sbin\:/usr/local/bin\:/usr/sbin\:/usr/bin\:/sbin\:/bin\:/home/render/bin
