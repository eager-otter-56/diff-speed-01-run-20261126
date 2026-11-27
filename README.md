[![make.fun · diff-speed-01-run-20261126](https://make.fun/badge/diff-speed-01-run-20261126.svg)](https://make.fun/bounty/diff-speed-01-run-20261126?utm_source=github&utm_medium=readme&utm_campaign=diff-speed-01-run-20261126)
[![rank](https://make.fun/badge/diff-speed-01-run-20261126/eager-otter-56/diff-speed-01-run-20261126/rank.svg)](https://make.fun/bounty/diff-speed-01-run-20261126/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=diff-speed-01-run-20261126)
[![reward](https://make.fun/badge/diff-speed-01-run-20261126/eager-otter-56/diff-speed-01-run-20261126/reward.svg)](https://make.fun/bounty/diff-speed-01-run-20261126?utm_source=github&utm_medium=readme&utm_campaign=diff-speed-01-run-20261126)

diff-exact-fast — a faster drop-in for makefun-diff 1.0.0 ([bounty][b]).

`run(input)` in `solve.js` returns makefun-diff 1.0.0's patch of the
input `{ old, new }` — byte for byte, the same line tokenisation (cut
after every `\n`, a `\r` belongs to its line, a trailing line without
`\n` is a line too), the same edit script (common prefix, common suffix
of the rest, then Myers's greedy search with the deletion winning every
tie, no edge pruning, snakes followed to their end), and the same patch
format (header line, hunks with 3 lines of context, change runs listing
deletions before insertions, `%` after a line that ends its text
without a newline). `main.ts` is the harness driver: it reads
`/input/cases.json`, answers each case with `run`, and writes
`/output/answers.json`.

Where the speed comes from:

- Lines are interned to small integers once per case, through one Map
  shared by both texts, so every comparison inside the search is an
  integer comparison; the line strings themselves are kept for output.
- The search runs on one in-place Int32Array V: at each edit count only
  the diagonals of that parity are written, so the two predecessor
  values a step reads still hold the previous round's results, and no
  path objects are allocated per candidate (the reference builds a
  linked list of path components for every candidate it tries). A
  slice of each round's band is kept for the backtrack.
- The patch is assembled from the kept line strings directly, pushing
  the operator and the line as separate parts of one final join.

Verified locally against the practice set (4/4 byte-identical) and
against 36 further cases drawn with the competition's own generator
(36/36 byte-identical), plus 4,011 small random cases against the
reference (all identical). On the practice set `run()` takes roughly
a third of the reference's CPU time on the same machine. The module
has no dependencies and reads no clock, environment or file: its
output depends on its input alone.

[b]: https://make.fun/bounty/diff-speed-01-run-20261126
