"""Report what each tmux session's coding agent is doing, as one JSON document.

Runs on the remote host (Python 3.7+, stdlib only), fed over ssh stdin. The
server prepends one line, `ARGS = {...}`, carrying the artifact patterns.
"""
import datetime
import glob
import hashlib
import json
import math
import os
import re
import signal
import subprocess
import time

ARGS = globals().get("ARGS") or {}
HOME = os.path.expanduser("~")
CLAUDE = os.path.join(HOME, ".claude")
CODEX = os.path.join(HOME, ".codex")
CACHE_DIR = os.path.join(HOME, ".cache", "devbox")
CACHE_VERSION = 9
DEADLINE = 25
TAIL = 256 * 1024
HEAD = 512 * 1024
SCAN_MAX = 32 * 1024 * 1024
TEXT_MAX = 600
KEEP_ARTIFACTS = 40
KEEP_FILES = 40
SHOW_FILES = 20
PATCH_RE = re.compile(r"^\t*\*\*\* (Add File|Update File|Delete File|Move to): (.+)$", re.M)
SHELL_PATCH_RE = re.compile(r"(?:^|[\s;&|(])apply_patch[ \t]{0,8}(?:<<-?[ \t]{0,4}['\"]?[\w-]{1,32}['\"]?[^\n]{0,64})?\r?\n?\t{0,8}['\"]?\*\*\* Begin Patch")
END_PATCH_RE = re.compile(r"^\t*\*\*\* End Patch[ \t]*\r?$", re.M)
CD_RE = re.compile(r"(?:^|[\s;&|(])cd[ \t]")
PR_RE = r"https://github\.com/[\w.-]+/[\w.-]+/pull/\d+"
SCANNED = set()


def clip(text, limit=TEXT_MAX):
    if not isinstance(text, str):
        return None
    text = " ".join(text.split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def num(value):
    return value if isinstance(value, (int, float)) and math.isfinite(value) else 0


def epoch(stamp):
    try:
        if isinstance(stamp, (int, float)) and not isinstance(stamp, bool):
            return int(stamp / 1000) if stamp > 1e12 else int(stamp)
        if isinstance(stamp, str):
            return int(datetime.datetime.fromisoformat(stamp.replace("Z", "+00:00")).timestamp())
    except (ValueError, OverflowError, TypeError):
        return None
    return None


def read_json(path):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def alive(pid, started):
    try:
        os.kill(int(pid), 0)
    except (OSError, ValueError, TypeError, OverflowError):
        return False
    try:
        with open("/proc/{}/stat".format(int(pid))) as fh:
            fields = fh.read().rsplit(")", 1)[1].split()
    except (OSError, IndexError):
        return True
    return started is None or len(fields) < 20 or fields[19] == str(started)


def msg(rec):
    message = rec.get("message")
    return message if isinstance(message, dict) else {}


def strings(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for item in value.values():
            for text in strings(item):
                yield text
    elif isinstance(value, list):
        for item in value:
            for text in strings(item):
                yield text


def jsonl(data, partial_first):
    lines = data.split(b"\n")
    if partial_first:
        lines = lines[1:]
    for line in lines:
        if line.strip():
            try:
                rec = json.loads(line)
            except ValueError:
                continue
            if isinstance(rec, dict):
                yield rec


def read_range(path, start, length):
    with open(path, "rb") as fh:
        fh.seek(start)
        return fh.read(length)


def text_of(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = [b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text"]
        return "\n".join(p for p in parts if p) or None
    return None


def human_prompt(rec):
    if rec.get("type") != "user" or rec.get("isMeta") or rec.get("isSidechain") or rec.get("isCompactSummary"):
        return None
    content = msg(rec).get("content")
    if isinstance(content, list) and any(isinstance(b, dict) and b.get("type") == "tool_result" for b in content):
        return None
    text = text_of(content)
    if not text or text.startswith("[Request interrupted"):
        return None
    if text.lstrip().startswith("<"):
        name = re.search(r"<command-name>(.*?)</command-name>", text, re.S)
        if not name:
            return None
        args = re.search(r"<command-args>(.*?)</command-args>", text, re.S)
        return "{} {}".format(name.group(1).strip(), args.group(1).strip() if args else "").strip()
    return text


def tmux_panes():
    fmt = "\t".join(
        [
            "#{pane_id}",
            "#{session_name}",
            "#{window_active}",
            "#{pane_active}",
            "#{pane_current_command}",
            "#{pane_pid}",
            "#{pane_current_path}",
        ]
    )
    try:
        out = subprocess.run(
            ["tmux", "list-panes", "-a", "-F", fmt],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            universal_newlines=True,
            timeout=5,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return []
    panes = []
    for line in out.splitlines():
        parts = line.split("\t", 6)
        if len(parts) == 7:
            panes.append(
                {
                    "id": parts[0],
                    "session": parts[1],
                    "active": parts[2] == "1" and parts[3] == "1",
                    "cmd": parts[4],
                    "pid": parts[5],
                    "path": parts[6],
                }
            )
    return panes


def claude_registry():
    by_pane = {}
    folder = os.path.join(CLAUDE, "sessions")
    try:
        names = os.listdir(folder)
    except OSError:
        return by_pane
    for name in names:
        if not name.endswith(".json"):
            continue
        rec = read_json(os.path.join(folder, name))
        if not isinstance(rec, dict) or rec.get("kind") not in (None, "interactive"):
            continue
        if not alive(rec.get("pid"), rec.get("procStart")):
            continue
        pane = str(rec.get("tmux") or "").rpartition(".")[2]
        if not pane.startswith("%"):
            continue
        seen = by_pane.get(pane)
        if seen is None or num(rec.get("statusUpdatedAt")) > num(seen.get("statusUpdatedAt")):
            by_pane[pane] = rec
    return by_pane


def claude_transcript(session_id, cwd):
    projects = os.path.join(CLAUDE, "projects")
    if session_id:
        direct = os.path.join(projects, re.sub(r"[^a-zA-Z0-9]", "-", cwd or ""), session_id + ".jsonl")
        if os.path.isfile(direct):
            return direct
        try:
            for folder in os.listdir(projects):
                candidate = os.path.join(projects, folder, session_id + ".jsonl")
                if os.path.isfile(candidate):
                    return candidate
        except OSError:
            return None
        return None
    folder = os.path.join(projects, re.sub(r"[^a-zA-Z0-9]", "-", cwd or ""))
    try:
        files = [os.path.join(folder, f) for f in os.listdir(folder) if f.endswith(".jsonl")]
        files = [f for f in files if f not in SCANNED]
    except OSError:
        return None
    return max(files, key=os.path.getmtime) if files else None


def claude_tail(path, size):
    start = max(0, size - TAIL)
    info = {}
    last_text = None
    last_text_at = None
    away = None
    away_at = None
    turn_end = None
    last = None
    for rec in jsonl(read_range(path, start, TAIL), start > 0):
        kind = rec.get("type")
        if kind == "ai-title":
            info["aiTitle"] = rec.get("aiTitle")
        elif kind == "custom-title":
            info["customTitle"] = rec.get("customTitle")
        elif kind == "last-prompt":
            info["ask"] = rec.get("lastPrompt")
        elif kind == "system" and rec.get("subtype") == "away_summary":
            away, away_at = rec.get("content"), epoch(rec.get("timestamp"))
        elif kind == "system" and rec.get("subtype") == "turn_duration":
            turn_end = epoch(rec.get("timestamp"))
        if kind in ("user", "assistant") and not rec.get("isSidechain"):
            last = rec
        if kind == "user" and (text_of(msg(rec).get("content")) or "").startswith("[Request interrupted"):
            turn_end = epoch(rec.get("timestamp"))
        if kind == "assistant" and not rec.get("isSidechain"):
            message = msg(rec)
            if rec.get("isApiErrorMessage"):
                info["error"] = rec.get("error") or "api error"
                continue
            info.pop("error", None)
            if message.get("model") and message.get("model") != "<synthetic>":
                info["model"] = message.get("model")
            if rec.get("gitBranch"):
                info["branch"] = rec.get("gitBranch")
            for block in message.get("content") or []:
                if not isinstance(block, dict):
                    continue
                if block.get("type") == "text" and block.get("text", "").strip():
                    last_text, last_text_at = block["text"], epoch(rec.get("timestamp"))
                elif block.get("type") == "tool_use" and block.get("name") == "TodoWrite":
                    todos = (block.get("input") or {}).get("todos") or []
                    info["tasks"] = task_counts(
                        [{"status": t.get("status"), "activeForm": t.get("activeForm") or t.get("content")} for t in todos]
                    )
        prompt = human_prompt(rec)
        if prompt:
            info["askAt"] = epoch(rec.get("timestamp"))
            info["lastHuman"] = prompt
    if info.get("lastHuman"):
        info["ask"] = info.pop("lastHuman")
    if away and (away_at or 0) >= (last_text_at or 0):
        info["summary"], info["summaryAt"] = away, away_at
    elif last_text:
        info["summary"], info["summaryAt"] = last_text, last_text_at
    info["turnEnd"] = turn_end
    info["lastTextAt"] = last_text_at
    info["last"] = last
    return info


def claude_first_ask(path):
    for rec in jsonl(read_range(path, 0, HEAD), False):
        prompt = human_prompt(rec)
        if prompt and not re.match(r"^/[\w:-]+$", prompt):
            return prompt
    return None


def task_counts(items):
    total = len(items)
    if total == 0:
        return None
    done = sum(1 for t in items if t.get("status") == "completed")
    current = next((t.get("activeForm") or t.get("subject") for t in items if t.get("status") == "in_progress"), None)
    return {"done": done, "total": total, "current": clip(current, 120)}


def claude_tasks(session_id):
    folder = os.path.join(CLAUDE, "tasks", session_id or "")
    try:
        names = [n for n in os.listdir(folder) if n.endswith(".json")]
    except OSError:
        return None
    return task_counts([t for t in (read_json(os.path.join(folder, n)) for n in names) if isinstance(t, dict)])


def compile_patterns():
    patterns = [("PR", re.compile(PR_RE), None)]
    for item in ARGS.get("artifacts") or []:
        try:
            patterns.append((str(item["label"]), re.compile(item["pattern"]), item.get("link") or None))
        except (KeyError, TypeError, re.error):
            continue
    return patterns


def scan_history(path, size, ino, cache, patterns, cwd=None):
    entry = cache.get(path)
    if not isinstance(entry, dict) or entry.get("ino") != ino or entry.get("off", 0) > size:
        entry = {"ino": ino, "off": max(0, size - SCAN_MAX), "artifacts": {}, "commits": 0, "tasks": {}, "files": {}}
    offset = entry["off"]
    data = read_range(path, offset, min(size - offset, SCAN_MAX)) if size > offset else b""
    end = data.rfind(b"\n") + 1
    if end == 0 and len(data) >= SCAN_MAX:
        end = len(data)
    artifacts = entry["artifacts"]
    links = any(link for _, _, link in patterns)
    for line in data[:end].split(b"\n"):
        if (
            b"http" not in line
            and b"gitOperation" not in line
            and b'"task' not in line.lower()
            and b"-title" not in line
            and b"filePath" not in line
            and b"apply_patch" not in line
            and b"turn_context" not in line
            and b"session_meta" not in line
            and not (links and any(regex.search(line.decode("utf-8", "replace")) for _, regex, link in patterns if link))
        ):
            continue
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        if rec.get("type") == "ai-title" and rec.get("aiTitle"):
            entry["title"] = rec["aiTitle"]
        if rec.get("type") == "custom-title" and rec.get("customTitle"):
            entry["customTitle"] = rec["customTitle"]
        if rec.get("type") in ("last-prompt", "ai-title", "custom-title"):
            continue
        at = epoch(rec.get("timestamp")) or 0
        said = rec.get("type") == "assistant" or (
            rec.get("type") == "user" and "toolUseResult" not in rec and not rec.get("isMeta")
        )
        op = (rec.get("toolUseResult") or {}).get("gitOperation") if isinstance(rec.get("toolUseResult"), dict) else None
        found = {}
        if isinstance(op, dict):
            if isinstance(op.get("commit"), dict):
                entry["commits"] += 1
            pr = op.get("pr")
            if isinstance(pr, dict) and pr.get("url"):
                found[pr["url"]] = ("PR", pr.get("action"), True)
        track_tasks(entry["tasks"], rec)
        meta = rec.get("payload") if rec.get("type") in ("session_meta", "turn_context") else None
        if isinstance(meta, dict) and isinstance(meta.get("cwd"), str):
            entry["cwd"] = meta["cwd"]
        track_files(entry["files"], rec, at, entry.get("cwd") or cwd)
        if rec.get("type") == "pr-link" and rec.get("prUrl"):
            found.setdefault(rec["prUrl"], ("PR", None, True))
        for text in strings(rec):
            for label, regex, link in patterns:
                for match in regex.finditer(text):
                    found.setdefault(link.replace("{0}", match.group(0)) if link else match.group(0), (label, None, said))
        for url, (label, action, by_someone) in found.items():
            note(artifacts, label, url, at, action, by_someone)
    entry["off"] = offset + end
    if len(artifacts) > KEEP_ARTIFACTS:
        rank = lambda kv: (kv[1].get("said", False), kv[1].get("hits", 1), kv[1]["at"])
        keep = sorted(artifacts.items(), key=rank)[-KEEP_ARTIFACTS:]
        entry["artifacts"] = artifacts = dict(keep)
    if len(entry["files"]) > KEEP_FILES:
        entry["files"] = dict(sorted(entry["files"].items(), key=lambda kv: kv[1]["at"])[-KEEP_FILES:])
    cache[path] = entry
    SCANNED.add(path)
    return entry


def track_files(files, rec, at, cwd):
    result = rec.get("toolUseResult")
    if isinstance(result, dict) and isinstance(result.get("filePath"), str):
        touch(files, result["filePath"], "created" if result.get("type") == "create" else "edited", at)
    payload = rec.get("payload") if isinstance(rec.get("payload"), dict) else {}
    patch = payload.get("input") if payload.get("type") == "custom_tool_call" and payload.get("name") == "apply_patch" else None
    if payload.get("type") == "function_call" and payload.get("name") in ("apply_patch", "shell", "shell_command", "exec_command"):
        raw = payload.get("arguments")
        try:
            args = raw if isinstance(raw, dict) else json.loads(raw or "{}")
        except (TypeError, ValueError):
            args = None
        if isinstance(args, dict):
            command = args.get("command") or args.get("cmd")
            parts = [c for c in (command if isinstance(command, list) else [command]) if isinstance(c, str)]
            workdir = args.get("workdir")
            if isinstance(workdir, str) and workdir:
                cwd = os.path.join(cwd, os.path.expanduser(workdir)) if cwd else os.path.expanduser(workdir)
            if payload["name"] == "apply_patch":
                patch = args.get("input")
            elif len(parts) == 2 and parts[0] == "apply_patch":
                patch = parts[1]
            elif parts:
                patch = shell_patches(parts[-1])
    if not isinstance(patch, str):
        return
    last = None
    for match in PATCH_RE.finditer(patch):
        name = match.group(2).strip()
        full = name if os.path.isabs(name) or not cwd else os.path.join(cwd, name)
        if match.group(1) == "Move to" and last:
            touch(files, last, "deleted", at)
        touch(files, full, {"Add File": "created", "Update File": "edited", "Delete File": "deleted", "Move to": "created"}[match.group(1)], at)
        last = full


def shell_patches(script):
    found, at = [], 0
    while True:
        call = SHELL_PATCH_RE.search(script, at)
        if not call or CD_RE.search(script, 0, call.start()):
            break
        end = END_PATCH_RE.search(script, call.end())
        if not end:
            break
        found.append(script[call.end() - len("*** Begin Patch"):end.end()])
        at = end.end()
    return "\n".join(found) or None


def touch(files, path, action, at):
    path = os.path.normpath(path)
    if not os.path.isabs(path) or "/.claude/" in path or "/.codex/" in path:
        return
    seen = files.setdefault(path, {"action": action, "at": at, "count": 0})
    seen["count"] += 1
    seen["at"] = max(seen["at"], at)
    if action != "edited" or seen["action"] == "deleted":
        seen["action"] = action


def files_out(files):
    ranked = sorted(files.items(), key=lambda kv: -kv[1]["at"])[:SHOW_FILES]
    return [dict(f, path=p, gone=not os.path.exists(p)) for p, f in ranked]


def track_tasks(tasks, rec):
    result = rec.get("toolUseResult")
    task = result.get("task") if isinstance(result, dict) else None
    if isinstance(task, dict) and task.get("id") and task.get("subject"):
        tasks.setdefault(str(task["id"]), {"status": "pending"})["subject"] = task["subject"]
    for block in msg(rec).get("content") or []:
        if isinstance(block, dict) and block.get("type") == "tool_use" and block.get("name") == "TaskUpdate":
            update = block.get("input") or {}
            if update.get("taskId") and update.get("status"):
                tasks.setdefault(str(update["taskId"]), {})["status"] = update["status"]


def note(artifacts, label, url, at, action, said):
    seen = artifacts.setdefault(
        url, {"label": label, "url": url, "at": at, "first": at, "action": None, "hits": 0, "said": False}
    )
    seen["at"] = max(seen["at"], at)
    seen["hits"] += 1
    seen["said"] = seen["said"] or said
    if action:
        seen["action"] = action


def claude_insight(pane, reg, cache, patterns):
    session_id = reg.get("sessionId") if reg else None
    path = claude_transcript(session_id, (reg or {}).get("cwd") or pane["path"])
    out = {"agent": "claude"}
    if reg:
        status = reg.get("status")
        out["state"] = {"busy": "working", "waiting": "waiting", "idle": "ready"}.get(status, "unknown")
        if reg.get("waitingFor"):
            out["waitingFor"] = reg["waitingFor"]
        out["since"] = epoch(reg.get("statusUpdatedAt"))
    if not path:
        out.setdefault("state", "unknown")
        return out
    stat = os.stat(path)
    info = claude_tail(path, stat.st_size)
    if not reg:
        last = info.get("last") or {}
        message = msg(last)
        ended = info.get("turnEnd") and info["turnEnd"] >= (epoch(last.get("timestamp")) or 0)
        out["state"] = "ready" if ended or message.get("stop_reason") == "end_turn" else "working"
        out["since"] = info.get("turnEnd") or epoch(last.get("timestamp"))
    if info.get("error") and out.get("state") in (None, "ready", "unknown", "working") and not (
        reg and reg.get("status") in ("busy", "waiting")
    ):
        out["state"] = "error"
        out["error"] = clip(str(info["error"]), 120)
    entry = scan_history(path, stat.st_size, stat.st_ino, cache, patterns)
    out["title"] = clip(
        info.get("customTitle") or entry.get("customTitle") or info.get("aiTitle") or entry.get("title"), 120
    )
    out["ask"] = clip(info.get("ask"))
    out["askAt"] = info.get("askAt")
    if "firstAsk" not in entry:
        entry["firstAsk"] = claude_first_ask(path)
    out["firstAsk"] = clip(entry["firstAsk"])
    out["summary"] = clip(info.get("summary"), 1200)
    out["summaryAt"] = info.get("summaryAt")
    out["turnAt"] = info.get("turnEnd") or info.get("lastTextAt")
    out["model"] = info.get("model")
    out["branch"] = info.get("branch")
    tracked = [t for t in entry["tasks"].values() if t.get("subject") and t.get("status") != "deleted"]
    out["tasks"] = claude_tasks(session_id) or task_counts(tracked) or info.get("tasks")
    out["artifacts"] = sorted(entry["artifacts"].values(), key=lambda a: -a["at"])
    out["commits"] = entry["commits"]
    out["files"] = files_out(entry["files"])
    return out


def codex_rollouts(days=14):
    cutoff = time.time() - days * 86400
    paths = [p for p in glob.glob(os.path.join(CODEX, "sessions", "*", "*", "*", "rollout-*.jsonl")) if os.path.getmtime(p) >= cutoff]
    rollouts = []
    for path in sorted(paths, key=os.path.getmtime, reverse=True):
        try:
            with open(path, "rb") as fh:
                meta = json.loads(fh.readline()).get("payload") or {}
        except (OSError, ValueError):
            continue
        if meta.get("thread_source", "user") == "user" and meta.get("source", "cli") == "cli" and meta.get("cwd"):
            rollouts.append({"path": path, "cwd": os.path.realpath(meta["cwd"])})
    return rollouts


def process_children():
    children = {}
    for pid in os.listdir("/proc") if os.path.isdir("/proc") else []:
        if not pid.isdigit():
            continue
        try:
            with open("/proc/{}/stat".format(pid)) as fh:
                ppid = fh.read().rsplit(")", 1)[1].split()[1]
        except (OSError, IndexError):
            continue
        children.setdefault(ppid, []).append(pid)
    return children


def open_rollout(pane_pid, children):
    todo, found = [pane_pid], []
    while todo:
        pid = todo.pop()
        todo.extend(children.get(pid, []))
        try:
            fds = os.listdir("/proc/{}/fd".format(pid))
        except OSError:
            continue
        for fd in fds:
            try:
                target = os.readlink("/proc/{}/fd/{}".format(pid, fd))
            except OSError:
                continue
            if os.path.basename(target).startswith("rollout-") and target.endswith(".jsonl"):
                found.append(target)
    return max(found, key=os.path.getmtime) if found else None


def codex_insight(pane, rollouts, children, cache, patterns):
    out = {"agent": "codex", "state": "unknown"}
    real = os.path.realpath(pane["path"])
    rollout = open_rollout(pane["pid"], children) or next((r["path"] for r in rollouts if r["cwd"] == real and r["path"] not in SCANNED), None)
    if not rollout:
        return out
    stat = os.stat(rollout)
    start = max(0, stat.st_size - TAIL)
    state_at = None
    for rec in jsonl(read_range(rollout, start, TAIL), start > 0):
        payload = rec.get("payload") if isinstance(rec.get("payload"), dict) else {}
        kind = payload.get("type")
        at = epoch(rec.get("timestamp"))
        if kind == "task_started":
            out["state"], state_at = "working", at
        elif kind in ("task_complete", "turn_aborted"):
            out["state"], state_at = "ready", at
            out["turnAt"] = at
            if payload.get("last_agent_message"):
                out["summary"], out["summaryAt"] = clip(payload["last_agent_message"], 1200), at
        elif rec.get("type") == "turn_context" and payload.get("model"):
            out["model"] = payload["model"]
        elif kind == "user_message" and payload.get("message"):
            out["ask"], out["askAt"] = clip(payload["message"]), at
        elif kind == "agent_message" and payload.get("message"):
            out["summary"], out["summaryAt"] = clip(payload["message"], 1200), at
        elif kind == "function_call" and payload.get("name") == "update_plan":
            try:
                plan = json.loads(payload.get("arguments") or "{}").get("plan") or []
            except ValueError:
                plan = []
            out["tasks"] = task_counts([{"status": p.get("status"), "activeForm": p.get("step")} for p in plan])
    out["since"] = state_at
    out["title"] = clip(codex_title(os.path.basename(rollout)), 120)
    entry = scan_history(rollout, stat.st_size, stat.st_ino, cache, patterns, real)
    out["artifacts"] = sorted(entry["artifacts"].values(), key=lambda a: -a["at"])
    out["commits"] = entry["commits"]
    out["files"] = files_out(entry["files"])
    return out


def codex_title(rollout_name):
    match = re.search(r"([0-9a-f]{8}-[0-9a-f-]{27})\.jsonl$", rollout_name)
    if not match:
        return None
    title = None
    try:
        with open(os.path.join(CODEX, "session_index.jsonl"), encoding="utf-8") as fh:
            for line in fh:
                if match.group(1) in line:
                    try:
                        title = json.loads(line).get("thread_name") or title
                    except ValueError:
                        continue
    except OSError:
        return None
    return title


def save_cache(path, cache, key):
    live = {"v": CACHE_VERSION, "key": key, "files": {p: e for p, e in cache.items() if p in SCANNED}}
    try:
        os.makedirs(CACHE_DIR, exist_ok=True)
        tmp = "{}.{}".format(path, os.getpid())
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(live, fh)
        os.replace(tmp, path)
        for old in glob.glob(os.path.join(CACHE_DIR, "agent-probe*.json*")):
            if old != path and os.path.getmtime(old) < time.time() - 7 * 86400:
                os.remove(old)
    except OSError:
        pass


def main():
    os.umask(0o077)
    if hasattr(signal, "SIGALRM"):
        signal.signal(signal.SIGALRM, lambda *_: os._exit(124))
        signal.alarm(DEADLINE)
    patterns = compile_patterns()
    key = json.dumps([CACHE_VERSION] + [[label, regex.pattern, link] for label, regex, link in patterns])
    cache_path = os.path.join(CACHE_DIR, "agent-probe-{}.json".format(hashlib.sha1(key.encode()).hexdigest()[:12]))
    stored = read_json(cache_path)
    fresh = isinstance(stored, dict) and stored.get("v") == CACHE_VERSION and stored.get("key") == key
    cache = stored["files"] if fresh else {}
    registry = claude_registry()
    rollouts = None
    children = None
    chosen = {}
    for pane in tmux_panes():
        reg = registry.get(pane["id"])
        if reg or pane["cmd"] == "claude":
            kind = "claude"
        elif pane["cmd"] == "codex":
            kind = "codex"
        else:
            continue
        best = chosen.get(pane["session"])
        if best is None or (pane["active"] and not best[0]["active"]):
            chosen[pane["session"]] = (pane, kind, reg)
    agents = []
    for session, (pane, kind, reg) in sorted(chosen.items(), key=lambda item: item[1][2] is None):
        try:
            if kind == "claude":
                insight = claude_insight(pane, reg, cache, patterns)
            else:
                rollouts = codex_rollouts() if rollouts is None else rollouts
                children = process_children() if children is None else children
                insight = codex_insight(pane, rollouts, children, cache, patterns)
        except Exception as err:
            insight = {"agent": kind, "state": "unknown", "error": clip("probe: {}".format(err), 120)}
        insight["session"] = session
        agents.append({k: v for k, v in insight.items() if v is not None})
    save_cache(cache_path, cache, key)
    print(json.dumps({"v": 1, "now": int(time.time()), "home": HOME, "agents": agents}))


main()
