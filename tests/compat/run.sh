#!/usr/bin/env bash
# Pi on systems and CPUs other than the one it was built on, without root and without those machines:
#   - in the userland of an old distribution (its glibc, shell and tools), fetched from Docker Hub and entered with bubblewrap:
#     CentOS 7 (glibc 2.17, the oldest supported), Debian 9, Amazon Linux 2;
#   - on emulated CPUs (qemu-user): Intel Haswell and Skylake, which run the compiled code of the main build; Sandy Bridge and
#     Nehalem, which have no AVX2 and run the baseline build, and the main one from bytecode.
# Each runs bench/stress.py's concurrent scenario (large tool work), whose tool results and requests must equal the reference's:
# a stock-Bun build of Pi in the same userland, or the main build on this CPU.
#
# Usage: tests/compat/run.sh [--builds DIR] [--stable PI] [--only userlands|cpus]
#   --builds DIR   where the unpacked release archives are (pi-bolt-linux-x64/, -baseline/, -jit/). Default: out/, with the
#                  names build-pi.sh gives them (pi-bolt, pi-bolt-baseline, pi-bolt-jit)
#   --stable PI    the stock-Bun build (scripts/build-pi.sh --stable). Default: out/pi-stable/pi
# Needs: bwrap and curl for the userlands (unprivileged user namespaces), qemu-x86_64-static for the CPUs. What is missing is
# skipped, and said.
source "$(dirname "$0")/../../scripts/lib/common.sh"
set +e

BUILDS=""; STABLE="$PIBOLT_ROOT/out/pi-stable/pi"; ONLY=""
while [ $# -gt 0 ]; do
	case "$1" in
	--builds) BUILDS="$(realpath "$2")"; shift ;;
	--stable) STABLE="$(realpath "$2")"; shift ;;
	--only) ONLY="$2"; shift ;;
	-h | --help) sed -n '2,15p' "$0"; exit 0 ;;
	*) die "unknown option $1" ;;
	esac
	shift
done
if [ -n "$BUILDS" ]; then
	MAIN="$BUILDS/pi-bolt-linux-x64"; BASELINE="$BUILDS/pi-bolt-linux-x64-baseline"; JIT="$BUILDS/pi-bolt-linux-x64-jit"
else
	MAIN="$PIBOLT_ROOT/out/pi-bolt"; BASELINE="$PIBOLT_ROOT/out/pi-bolt-baseline"; JIT="$PIBOLT_ROOT/out/pi-bolt-jit"
fi
[ -x "$MAIN/pi" ] || die "no build at $MAIN (scripts/package-release.sh, or --builds)"
STRESS="$PIBOLT_ROOT/bench/stress.py"
ROOTS="$PIBOLT_WORK/compat"
status=0

# fetch IMAGE TAG DIR: the root filesystem of a Docker Hub library image, layer by layer.
fetch() {
	local image=$1 tag=$2 dir=$3 token manifest digest layer
	[ -e "$dir/bin/sh" ] && return 0
	mkdir -p "$dir"
	token=$(curl -fsSL "https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/$image:pull" | python3 -c 'import json, sys; print(json.load(sys.stdin)["token"])') || return 1
	manifest=$(curl -fsSL -H "Authorization: Bearer $token" -H "Accept: application/vnd.docker.distribution.manifest.list.v2+json" -H "Accept: application/vnd.oci.image.index.v1+json" \
		-H "Accept: application/vnd.docker.distribution.manifest.v2+json" "https://registry-1.docker.io/v2/library/$image/manifests/$tag") || return 1
	digest=$(python3 -c 'import json, sys
m = json.load(sys.stdin)
print(next((x["digest"] for x in m.get("manifests", []) if x["platform"]["architecture"] == "amd64" and x["platform"]["os"] == "linux"), ""))' <<<"$manifest")
	if [ -n "$digest" ]; then
		manifest=$(curl -fsSL -H "Authorization: Bearer $token" -H "Accept: application/vnd.docker.distribution.manifest.v2+json" -H "Accept: application/vnd.oci.image.manifest.v1+json" \
			"https://registry-1.docker.io/v2/library/$image/manifests/$digest") || return 1
	fi
	for layer in $(python3 -c 'import json, sys; [print(x["digest"]) for x in json.load(sys.stdin)["layers"]]' <<<"$manifest"); do
		curl -fsSL -H "Authorization: Bearer $token" "https://registry-1.docker.io/v2/library/$image/blobs/$layer" | tar -xz -C "$dir" --no-same-owner --exclude='dev/*' 2>/dev/null
	done
	[ -e "$dir/bin/sh" ]
}

report() { # report NAME: stress.py's verdict from stdin
	local name=$1 out
	out=$(cat)
	if grep -q "^PASS" <<<"$out"; then
		echo "PASS $name"
	else
		echo "FAIL $name"
		grep "FAIL\|did not finish" <<<"$out" | head -4 | cut -c1-220 | sed 's/^/   /'
		status=1
	fi
}

if [ "$ONLY" != cpus ]; then
	if ! command -v bwrap >/dev/null || ! bwrap --ro-bind / / true 2>/dev/null; then
		echo "SKIP userlands: bubblewrap cannot make a user namespace here"
	elif [ ! -x "$STABLE" ]; then
		echo "SKIP userlands: no stock-Bun build at $STABLE (scripts/build-pi.sh --stable --out out/pi-stable)"
	else
		home=$(mktemp -d /tmp/pibolt-compat-XXXXXX)
		for userland in "centos 7" "debian 9" "amazonlinux 2"; do
			read -r image tag <<<"$userland"
			root="$ROOTS/$image-$tag"
			fetch "$image" "$tag" "$root" || { echo "SKIP $image $tag: could not fetch it"; continue; }
			enter="bwrap --bind $root / --dev /dev --proc /proc --bind /tmp /tmp --ro-bind $MAIN /pi/main --ro-bind $BASELINE /pi/baseline --ro-bind $JIT /pi/jit --ro-bind $(dirname "$STABLE") /pi/stable --setenv PATH /usr/local/bin:/usr/bin:/bin --setenv HOME $home --die-with-parent"
			glibc=$($enter /bin/sh -c 'ldd --version 2>&1 | head -1' | grep -o '[0-9.]*$')
			python3 "$STRESS" --reference "stable=$enter /pi/stable/pi" --build "main=$enter /pi/main/pi" --build "baseline=$enter /pi/baseline/pi" --build "jit=$enter /pi/jit/pi" \
				--only concurrent,faults,signals --concurrency 6 2>&1 | report "$image $tag (glibc $glibc): the three builds"
		done
		rm -rf "$home"
	fi
fi

if [ "$ONLY" != userlands ]; then
	qemu=$(command -v qemu-x86_64-static || command -v qemu-x86_64)
	if [ -z "$qemu" ]; then
		echo "SKIP CPUs: no qemu-x86_64-static"
	else
		for cpu in Haswell Skylake-Client SandyBridge Nehalem; do
			used=$(BUN_STATIC_HEAP_VERBOSE=1 "$qemu" -cpu "$cpu" "$MAIN/pi" --version 2>&1 | grep -c "image registered: true")
			case "$cpu" in
			Haswell | Skylake-Client) want=1; what="runs its compiled code" ;;
			*) want=0; what="falls back to bytecode" ;;
			esac
			if [ "$used" = "$want" ]; then
				echo "PASS $cpu: the main build $what"
			else
				echo "FAIL $cpu: the main build should be one that $what"
				status=1
			fi
			python3 "$STRESS" --reference "here=$MAIN/pi" --build "main=$qemu -cpu $cpu $MAIN/pi" --build "baseline=$qemu -cpu $cpu $BASELINE/pi" --only concurrent --concurrency 2 2>&1 |
				report "$cpu: the main and baseline builds"
		done
	fi
fi
exit $status
