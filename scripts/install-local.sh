#!/usr/bin/env bash
# Install dsh-live-diff from this checkout into a DSH profile without pnpm.
#
#   ./scripts/install-local.sh            # profile "web"
#   ./scripts/install-local.sh myprofile  # another profile
#   ./scripts/install-local.sh --remove   # take it back out
#
# It copies the package into <profile>/node_modules and registers the bundle in
# <profile>/package.json, which is exactly what `dsh plugin add` ends up with —
# but with no network, no store lock, and no pnpm.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE="web"
REMOVE=0

for arg in "$@"; do
	case "$arg" in
		--remove) REMOVE=1 ;;
		-*) echo "unknown option: $arg" >&2; exit 2 ;;
		*) PROFILE="$arg" ;;
	esac
done

DEST="$DSH_HOME/profiles/$PROFILE"
MANIFEST="$DEST/package.json"
PKG="$DEST/node_modules/dsh-live-diff"

if [ ! -f "$MANIFEST" ]; then
	echo "error: no DSH profile at $DEST" >&2
	echo "       open the app once (or run 'dsh --profile $PROFILE') to create it" >&2
	exit 1
fi

node - "$MANIFEST" "$SRC" "$PKG" "$REMOVE" <<'NODE'
const { cpSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } = require("node:fs");
const { dirname, join } = require("node:path");

const [manifestPath, src, pkgDir, removeFlag] = process.argv.slice(2);
const remove = removeFlag === "1";
const NAME = "dsh-live-diff";

const raw = require("node:fs").readFileSync(manifestPath, "utf8");
const manifest = JSON.parse(raw);
const before = JSON.stringify(manifest, null, 2);

manifest.dependencies = manifest.dependencies ?? {};
manifest.dsh = manifest.dsh ?? {};
manifest.dsh.profile = manifest.dsh.profile ?? {};
const bundles = manifest.dsh.profile.bundles ?? [];

if (remove) {
	delete manifest.dependencies[NAME];
	manifest.dsh.profile.bundles = bundles.filter((name) => name !== NAME);
	rmSync(pkgDir, { recursive: true, force: true });
} else {
	manifest.dependencies[NAME] = `file:${src}`;
	if (!bundles.includes(NAME)) manifest.dsh.profile.bundles = [...bundles, NAME];
	mkdirSync(pkgDir, { recursive: true });
	for (const item of ["lib", "package.json", "cordis.patch.yml", "README.md", "LICENSE"]) {
		const from = join(src, item);
		if (!existsSync(from)) continue;
		cpSync(from, join(pkgDir, item), { recursive: true });
	}
}

const after = JSON.stringify(manifest, null, 2);
if (after !== before) {
	renameSync(manifestPath, `${manifestPath}.bak`);
	writeFileSync(manifestPath, after + "\n");
	console.log(`${remove ? "unregistered" : "registered"} ${NAME} in ${manifestPath} (backup: package.json.bak)`);
} else {
	console.log(`nothing to change in ${manifestPath}`);
}
console.log(remove ? `removed ${pkgDir}` : `copied package into ${pkgDir}`);
NODE

if [ "$REMOVE" -eq 1 ]; then
	echo "restart DSH for the removal to take effect."
else
	echo "restart DSH for the plugin to load: dsh --profile $PROFILE"
fi
