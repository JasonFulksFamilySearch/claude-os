#!/usr/bin/env python3
"""
validate_frontmatter.py — deterministic scorer for the mechanical parts of the
skill-auditor rubric (Phase-2 extended):
  A1       frontmatter validity (score, verbatim)
  A2_hard  name charset/length/reserved words (gate)
  A3_mech  description length vs 1,536 + first/second-person detection (gates:
           any failure -> A3 = 0, final; otherwise model judges the 1-4 ladder)
  B3_count major instructions + rationale-marker count -> R ratio and band
           (scored by script when countable; judged fallback when denominator=0)
  E1_deny  declared tool on the local deny list (deny-direction only; the
           body-usage direction is judged under the PORTABLE-ARTIFACT rule)

The auditor MUST transcribe these verdicts VERBATIM. Remaining judgment:
  - A2: precise-vs-vague (only when hard rules pass)
  - A3: the 1-4 ladder (only when both mech gates pass)
  - E1: body-usage direction (portable-artifact rule in rubrics.md)

stdlib only; no YAML dependency (regex frontmatter parse, by design: the same
input must always yield the same output).

USAGE:  python3 validate_frontmatter.py <path/to/SKILL.md> [--settings FILE]...
OUTPUT: one JSON object on stdout (sorted keys). Exit 0 always (a scoring
        outcome is not a script failure); exit 2 only on unreadable input.
"""
import json, re, sys, os

# --- A3 mechanical gates ------------------------------------------------------
DESC_CHAR_LIMIT = 1536
PERSON_PATTERNS = [   # first/second person in a description = auto-0 (doc rule)
    r"\bI can\b", r"\bI'll\b", r"\bI will\b", r"\bI help\b", r"\bI am\b",
    r"\bYou can\b", r"\bYou will\b", r"\bYou'll\b", r"\bHelps you\b",
    r"我可以", r"我能", r"我会", r"你可以", r"您可以",
]

# --- B3 deterministic count ---------------------------------------------------
# Major instruction (structural proxy, fixed by rule): a top-level bullet
# ('- ' or '* ') or numbered line ('N. ') at indent 0, outside code fences and
# markdown tables, in the body. Rationale marker: fixed lexicon below appearing
# in that line. Fairness is approximate; determinism is exact.
RATIONALE_MARKERS = [
    "because", "so that", "to avoid", "to prevent", "to ensure", "since ",
    "otherwise", "this ensures", "this prevents", "which ensures",
    "因为", "以便", "避免", "防止", "否则", "以确保", "从而", "确保不",
]
B3_BANDS = [(0.0, 0), (0.25, 1), (0.50, 2), (0.85, 3), (1.01, 4)]  # R<=bound -> band

DOCUMENTED_KEYS = {
    "name", "description", "when_to_use", "argument-hint", "arguments",
    "disable-model-invocation", "user-invocable", "allowed-tools",
    "disallowed-tools", "model", "effort", "context", "agent", "hooks",
    "paths", "shell",
}
RESERVED_WORDS = ("anthropic", "claude")
NAME_RE = re.compile(r"^[a-z0-9-]{1,64}$")
KEY_RE = re.compile(r"^([^\s:][^:]*):(\s|$)")  # top-level 'key:' (not indented)


def parse_frontmatter(text):
    """Return (keys: list[(key, lineno)], values: dict, error: str|None)."""
    lines = text.split("\n")
    if not lines or lines[0].strip() != "---":
        return [], {}, "frontmatter missing: file does not open with ---"
    close = None
    for i in range(1, len(lines)):
        if lines[i].strip() == "---":
            close = i
            break
    if close is None:
        return [], {}, "frontmatter malformed: no closing ---"
    keys, values = [], {}
    for i in range(1, close):
        line = lines[i]
        if not line.strip() or line.startswith(("#",)):
            continue
        if line[0] in (" ", "\t"):           # continuation / nested — not top-level
            continue
        m = KEY_RE.match(line)
        if not m:
            return keys, values, f"frontmatter parse error: L{i+1} is not 'key: value'"
        k = m.group(1).strip()
        keys.append((k, i + 1))
        values[k] = line.split(":", 1)[1].strip()
    return keys, values, None


def collect_value(text, key):
    """Value incl. folded continuation lines (for description presence check)."""
    lines = text.split("\n")
    out, grab = [], False
    for i, line in enumerate(lines[1:], start=2):
        if line.strip() == "---":
            break
        if grab:
            if line[:1] in (" ", "\t"):
                out.append(line.strip())
                continue
            break
        m = KEY_RE.match(line)
        if m and m.group(1).strip() == key:
            grab = True
            v = line.split(":", 1)[1].strip()
            if v and v not in (">", ">-", "|", "|-"):
                out.append(v)
    return " ".join(out).strip()


def score_a1(keys, values, err, text):
    if err:
        return {"criterion": "A1", "score": 0, "max": 2,
                "evidence": err, "doc_rule": "Frontmatter reference — valid field set"}
    undocumented = [(k, ln) for k, ln in keys if k not in DOCUMENTED_KEYS]
    if undocumented:
        ev = "; ".join(f"undocumented key '{k}' (L{ln})" for k, ln in undocumented)
        return {"criterion": "A1", "score": 0, "max": 2, "evidence": ev,
                "doc_rule": "Frontmatter reference — valid field set"}
    if "description" not in values or not collect_value(text, "description"):
        return {"criterion": "A1", "score": 1, "max": 2,
                "evidence": "all keys documented; description ABSENT",
                "doc_rule": "Frontmatter reference — valid field set"}
    return {"criterion": "A1", "score": 2, "max": 2,
            "evidence": "all keys documented; description present",
            "doc_rule": "Frontmatter reference — valid field set"}


def check_a2_hard(values, skill_path):
    name = values.get("name", "").strip()
    source = "frontmatter"
    if not name:
        name = os.path.basename(os.path.dirname(os.path.abspath(skill_path)))
        source = "directory-default"
    violations = []
    if not NAME_RE.fullmatch(name):
        violations.append("charset/length: must match [a-z0-9-]{1,64}")
    for w in RESERVED_WORDS:
        if w in name.lower():
            violations.append(f"reserved word '{w}' in name")
    return {
        "name": name, "name_source": source,
        "hard_pass": not violations, "violations": violations,
        "verdict": ("HARD-FAIL -> A2 score 0 (report verbatim)" if violations else
                    "HARD-PASS -> model judges ONLY precise(2) vs vague(1)"),
    }


def check_e1_deny(values, settings_paths):
    declared_raw = values.get("allowed-tools", "")
    declared = [t for t in re.split(r"[,\s]+", declared_raw) if t]
    deny, files_found = [], []
    for p in settings_paths:
        p = os.path.expanduser(p)
        if not os.path.isfile(p):
            continue
        files_found.append(p)
        try:
            data = json.load(open(p))
            deny += data.get("permissions", {}).get("deny", []) or []
        except Exception as e:
            files_found[-1] = f"{p} (UNPARSEABLE: {e})"
    hits = sorted({d for d in declared for dn in deny
                   if d == dn or d.split("(")[0] == dn.split("(")[0]})
    if not declared:
        verdict = ("VACUOUS-PASS: no allowed-tools declared -> deny-direction "
                   "passes by rule (nothing declared can be denied); model judges "
                   "ONLY the body-usage direction (needed-but-undeclared)")
    elif hits:
        verdict = f"DENY-HIT {hits} -> E1 score 0 (report verbatim)"
    elif files_found:
        verdict = ("no declared tool is denied -> model judges only "
                   "needed-but-undeclared / declared-but-unused")
    else:
        verdict = ("UNRESOLVED: no settings file found and tools ARE declared — "
                   "deny direction unverifiable; apply absent-settings rule")
    return {
        "declared_allowed_tools": declared, "deny_list_sources": files_found,
        "deny_hits": hits, "verdict": verdict,
    }


def body_lines(text):
    """Lines after the closing --- of the frontmatter."""
    lines = text.split("\n")
    if lines and lines[0].strip() == "---":
        for i in range(1, len(lines)):
            if lines[i].strip() == "---":
                return lines[i+1:]
    return lines


def check_a3_mech(text, values):
    desc = collect_value(text, "description")
    wtu = collect_value(text, "when_to_use")
    combined = len(desc) + len(wtu)
    person_hits = sorted({p for p in PERSON_PATTERNS
                          if re.search(p, desc, re.IGNORECASE)})
    gates_pass = combined <= DESC_CHAR_LIMIT and not person_hits and bool(desc)
    if not desc:
        verdict = "GATE-FAIL: no description -> A3 = 0 (report verbatim)"
    elif combined > DESC_CHAR_LIMIT:
        verdict = (f"GATE-FAIL: {combined} chars > {DESC_CHAR_LIMIT} "
                   "(live truncation) -> A3 = 0 (report verbatim)")
    elif person_hits:
        verdict = (f"GATE-FAIL: first/second person {person_hits} "
                   "-> A3 = 0 (report verbatim)")
    else:
        verdict = ("GATES-PASS -> model judges the 1-4 ladder only "
                   "(trigger/task-type count + lead-sentence position)")
    return {"combined_chars": combined, "char_limit": DESC_CHAR_LIMIT,
            "person_hits": person_hits, "gates_pass": gates_pass,
            "verdict": verdict}


def check_b3_count(text):
    in_fence = False
    majors, with_marker = [], []
    for ln, raw in enumerate(body_lines(text), start=1):
        s = raw.rstrip()
        if s.lstrip().startswith("```"):
            in_fence = not in_fence
            continue
        if in_fence or not s or s.startswith("|"):
            continue
        if re.match(r"^(?:[-*]\s+|\d+[.)]\s+)", s):   # top-level bullet/numbered
            majors.append(ln)
            low = s.lower()
            if any(m in low for m in RATIONALE_MARKERS):
                with_marker.append(ln)
    n, k = len(majors), len(with_marker)
    if n == 0:
        return {"major_instructions": 0, "with_rationale_marker": 0,
                "ratio": None, "score": None,
                "verdict": ("NO COUNTABLE STRUCTURE (0 top-level bullets/steps) "
                            "-> model judges B3 from prose using the rubric "
                            "definitions; evidence must say 'judged fallback'")}
    r = k / n
    score = next(b for bound, b in B3_BANDS if r <= bound)
    # band 4 additionally requires a generalizing rationale — leave that single
    # check to judgment ONLY when the script says R > 0.85
    note = (" (R>0.85: model may confirm band 4 only if >=1 rationale "
            "generalizes; otherwise transcribe 3)" if score == 4 else "")
    return {"major_instructions": n, "with_rationale_marker": k,
            "marker_lines": with_marker[:10], "ratio": round(r, 3),
            "score": score if score < 4 else 3,
            "verdict": f"SCRIPT-COUNTED: {k}/{n} -> R={r:.2f} -> "
                       f"B3 = {min(score,3)}{note} (report verbatim)"}


def main():
    args = sys.argv[1:]
    settings = []
    while "--settings" in args:
        i = args.index("--settings")
        settings.append(args[i + 1])
        del args[i:i + 2]
    if len(args) != 1:
        print(json.dumps({"error": "usage: validate_frontmatter.py <SKILL.md> [--settings FILE]..."}))
        sys.exit(2)
    path = args[0]
    if not settings:
        cfg = os.environ.get("CLAUDE_CONFIG_DIR", "~/.claude")
        settings = [os.path.join(cfg, "settings.json"),
                    os.path.join(cfg, "settings.local.json")]
    try:
        text = open(path, encoding="utf-8", errors="replace").read()
    except OSError as e:
        print(json.dumps({"error": f"cannot read {path}: {e}"}))
        sys.exit(2)
    keys, values, err = parse_frontmatter(text)
    out = {
        "file": path,
        "A1": score_a1(keys, values, err, text),
        "A2_hard": check_a2_hard(values, path),
        "A3_mech": check_a3_mech(text, values),
        "B3_count": check_b3_count(text),
        "E1_deny": check_e1_deny(values, settings),
        "frontmatter_keys": [f"{k} (L{ln})" for k, ln in keys],
    }
    print(json.dumps(out, sort_keys=True, ensure_ascii=False, indent=2))
    sys.exit(0)


if __name__ == "__main__":
    main()
