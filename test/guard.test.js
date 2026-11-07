import assert from "node:assert/strict";
import test from "node:test";

import { shellEditReason } from "../lib/index.js";

test("blocks in-place sed on a tracked source file", () => {
	assert.match(shellEditReason("sed -i 's/old/new/' src/app.js"), /sed/);
	assert.match(shellEditReason("sed -i.bak -e 's/a/b/' lib/client.js"), /sed/);
});

test("allows in-place sed in disposable directories and read-only sed", () => {
	assert.equal(shellEditReason("sed -i 's/a/b/' node_modules/pkg/index.js"), undefined);
	assert.equal(shellEditReason("sed -i 's/a/b/' /tmp/scratch.txt"), undefined);
	assert.equal(shellEditReason("sed -n '1,20p' src/app.js"), undefined);
});

test("blocks perl -pi and git work-tree rewrites", () => {
	assert.match(shellEditReason("perl -pi -e 's/a/b/' src/app.js"), /perl/);
	assert.match(shellEditReason("git checkout -- src/app.js"), /git/);
	assert.match(shellEditReason("git apply fix.patch"), /git/);
});

test("blocks python heredocs that write tracked files", () => {
	const command = `python3 - <<'PY'\nfrom pathlib import Path\np = Path("lib/client.js")\np.write_text(p.read_text().replace("a", "b"))\nPY`;
	assert.match(shellEditReason(command), /python/);
});

test("allows python heredocs that only write temporary files", () => {
	const command = `python3 - <<'PY'\nopen("/tmp/report.txt", "w").write("ok")\nPY`;
	assert.equal(shellEditReason(command), undefined);
});

test("blocks shell redirections to source but not to /dev/null or build output", () => {
	assert.match(shellEditReason("echo hi > src/app.js"), /redirection/);
	assert.match(shellEditReason("cat notes.txt >> README.md"), /redirection/);
	assert.equal(shellEditReason("npm test 2>/dev/null"), undefined);
	assert.equal(shellEditReason("echo hi > /tmp/notes.txt"), undefined);
	assert.equal(shellEditReason("echo hi > output/build.txt"), undefined);
});

test("blocks tee and dd writes outside disposable directories", () => {
	assert.match(shellEditReason("echo hi | tee src/app.js"), /redirection/);
	assert.match(shellEditReason("dd if=/dev/zero of=src/app.js bs=1 count=1"), /redirection|dd/);
});

test("lets ordinary commands and tracked edit tools through", () => {
	assert.equal(shellEditReason("npm test"), undefined);
	assert.equal(shellEditReason("git status --short"), undefined);
	assert.equal(shellEditReason("python3 -c 'print(1)'"), undefined);
	assert.equal(shellEditReason(""), undefined);
});
