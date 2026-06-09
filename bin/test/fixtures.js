'use strict';

// Real `ps -axo pid,ppid,rss,pcpu,etime,command` rows (header + body) from the target Mac.
// Session A root 2081; Session B root 78068; forked session root 92394; daemon infra at ppid 1.
const PS_TEXT = `  PID  PPID    RSS  %CPU     ELAPSED COMMAND
    1     0  12000   0.0  31-07:46:00 /sbin/launchd
58725     1 170288   0.0    07:10:00 /Users/fulksjas/.local/bin/claude daemon run --json-path /Users/fulksjas/.claude/daemon.json --log-file /Users/fulksjas/.claude/daemon.log --origin transient --spawned-by {"label":"claude","cwd":"/Users/fulksjas/dev/Sandbox/Perch","pid":9553}
58735 58725 123456   0.1    07:09:00 /Users/fulksjas/.local/share/claude/versions/2.1.170 --bg-pty-host /tmp/cc-daemon-502/2de4f998/spare/67d62c6c.pty.sock 200 50 -- /Users/fulksjas/.local/share/claude/versions/2.1.170 --bg-spare /tmp/cc-daemon-502/2de4f998/spare/67d62c6c.claim.sock
58738 58735 145312   0.1    07:09:00 /Users/fulksjas/.local/share/claude/versions/2.1.170 --bg-spare /tmp/cc-daemon-502/2de4f998/spare/67d62c6c.claim.sock
92062     1  64864   0.1    05:00:00 /Users/fulksjas/.local/share/claude/ClaudeCode.app/Contents/MacOS/claude --bg-pty-host /tmp/cc-daemon-502/2de4f998/pty/581d4d15.sock 254 82 -- /Users/fulksjas/.local/share/claude/versions/2.1.168 --session-id 581d4d15-0c39-4bca-aa33-3f54b51fccbc --fork-session --resume /Users/fulksjas/.claude/projects/-Users-fulksjas-dev-Sandbox-Perch/2b26ba98.jsonl --effort xhigh --permission-mode bypassPermissions
92394 92062 241568   2.6    05:00:00 /Users/fulksjas/.local/share/claude/versions/2.1.168 --session-id 581d4d15-0c39-4bca-aa33-3f54b51fccbc --fork-session --resume /Users/fulksjas/.claude/projects/-Users-fulksjas-dev-Sandbox-Perch/2b26ba98.jsonl --effort xhigh --permission-mode bypassPermissions
 2081 12393 566144   0.1    02:00:00 /Users/fulksjas/.local/bin/claude
 2092  2081 457136   0.0    02:00:00 /Users/fulksjas/.nvm/versions/node/v24.15.0/bin/node /Users/fulksjas/.claude-os/mcp/dist/index.js
 2093  2081  53168   0.0    02:00:00 npm exec tsx /Users/fulksjas/dev/Misc/claude_mcp/claude-tdd-advisor/index.ts
 2377  2093  39600   0.0    02:00:00 node /Users/fulksjas/.npm/_npx/fd45a72a545557e9/node_modules/.bin/tsx /Users/fulksjas/dev/Misc/claude_mcp/claude-tdd-advisor/index.ts
 2427  2377  43920   0.0    02:00:00 /Users/fulksjas/.nvm/versions/node/v24.15.0/bin/node --require /Users/fulksjas/.npm/_npx/fd45a72a545557e9/node_modules/tsx/dist/preflight.cjs --import file:///loader.mjs /Users/fulksjas/dev/Misc/claude_mcp/claude-tdd-advisor/index.ts
78068 11111 540000   0.1    01:00:00 /Users/fulksjas/.local/bin/claude
78081 78068 626192   0.0    01:00:00 /Users/fulksjas/.nvm/versions/node/v24.15.0/bin/node /Users/fulksjas/.claude-os/mcp/dist/index.js
78082 78068 101536   0.0    01:00:00 npm exec tsx /Users/fulksjas/dev/Misc/claude_mcp/claude-tdd-advisor/index.ts
78375 78082  56240   0.0    01:00:00 node /Users/fulksjas/.npm/_npx/fd45a72a545557e9/node_modules/.bin/tsx /Users/fulksjas/dev/Misc/claude_mcp/claude-tdd-advisor/index.ts
78377 78375  78944   0.0    01:00:00 /Users/fulksjas/.nvm/versions/node/v24.15.0/bin/node --require /preflight.cjs /Users/fulksjas/dev/Misc/claude_mcp/claude-tdd-advisor/index.ts
99001     1  45000   0.0    00:00:01 /Users/fulksjas/.nvm/versions/node/v24.15.0/bin/node /Users/fulksjas/.claude-os/bin/resource-sampler.js`;

const VMSTAT_TEXT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                     4011.
Pages active:                                 974801.
Pages inactive:                               937983.
Pages speculative:                             37638.
Pages throttled:                                   0.
Pages wired down:                             219371.
Pages purgeable:                               29454.
"Translation faults":                     1800143461.
Pages copy-on-write:                        93800118.
Pages zero filled:                        1176006443.
Pages reactivated:                         226307305.
Pages purged:                               10730964.
File-backed pages:                            703751.
Anonymous pages:                             1246671.
Pages stored in compressor:                   655025.
Pages occupied by compressor:                 130170.
Decompressions:                            166289087.
Compressions:                              189157028.
Pageins:                                    25143190.
Pageouts:                                     185622.
Swapins:                                    10914804.
Swapouts:                                   14430430.`;

const SWAP_TEXT = `vm.swapusage: total = 4096.00M  used = 2648.00M  free = 1448.00M  (encrypted)`;
const LOADAVG_TEXT = `{ 4.80 5.64 5.66 }`;
const MEMSIZE_TEXT = `38654705664`;

module.exports = { PS_TEXT, VMSTAT_TEXT, SWAP_TEXT, LOADAVG_TEXT, MEMSIZE_TEXT };
