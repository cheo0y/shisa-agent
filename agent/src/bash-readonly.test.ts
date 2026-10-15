// 읽기만 하는 셸 명령 판정(승인 카드 없이 도는 것) — 애매하면 카드로
import { test } from "node:test";
import assert from "node:assert/strict";
import { isReadOnlyBash, splitReadOnly } from "./bash-readonly.ts";

const ctx = { cwd: "/Users/u/code/app", home: "/Users/u" };
const ro = (c: string) => isReadOnlyBash(c, ctx);

test("읽기 명령: cd·ls·cat·head·grep·find·git 읽기, 이어 붙이기(&& || ; |)와 2>/dev/null·2>&1", () => {
  for (const c of [
    "cd /Users/me/code/notes-app && git log --oneline | head -3 && ls && head -30 README.md 2>/dev/null",
    "ls", "ls -la", "ls *.ts", "pwd", "cat README.md", "head -n 5 src/a.ts", "tail -20 log.txt", "wc -l src/a.ts",
    "grep -rn 'foo$' src", "rg -n TODO src", "find . -name '*.ts' -type f", "tree -L 2", "file a.png", "stat a.ts", "du -sh .",
    "echo hi", "which node", "sort a.txt | uniq -c", "cut -d, -f1 a.csv", "jq .name package.json",
    "git status", "git status 2>&1 | tail -5", "git diff HEAD~1 -- src", "git show HEAD:README.md", "git log -5 --format=%h:%s",
    "git -C /Users/u/code/app log -3", "git --no-pager log", "git rev-parse HEAD", "git ls-files", "git blame a.ts", "git describe --tags",
    "git branch", "git branch -a", "git branch -vv", "git branch --show-current", "git branch --list 'feat/*'",
    "git remote -v", "git remote", "git remote show origin", "git tag", "git tag -l 'v1*'", "git tag --list",
    "ls >/dev/null", "git log 2>/dev/null || echo none", "cd .. ; ls", "cat \"a b.txt\"", "ls .env.example",
  ]) assert.ok(ro(c), c);
});

test("쓰기·실행·애매한 것은 아님(→ 승인 카드)", () => {
  for (const c of [
    "git clone https://github.com/x/y", "git fetch", "git pull", "git checkout main", "git stash", "git reset --hard", "git push",
    "ls > x", "ls >> x", "echo hi > a.txt", "ls 2>x", "cat a 1>b", "echo hi>/dev/nullx",
    "rm -rf x", "rm a", "mv a b", "cp a b", "touch a", "mkdir x", "npm test", "node a.js", "curl https://x",
    "find . -delete", "find . -exec rm {} ;", "find . -execdir ls ;", "find . -ok rm ;", "find . -fprint out",
    "git branch -D x", "git branch -d x", "git branch -m a b", "git branch --delete x", "git branch new-branch", "git branch -c a b",
    "git tag v1", "git tag -d v1", "git tag -a v1 -m x", "git remote add x y", "git remote remove x", "git remote set-url x y",
    "cat ~/.ssh/id_rsa", "cat .env", "cat .env.local", "head src/.env", "cat ~/.aws/credentials", "cat key.pem", "ls ~/.ssh",
    "cd ~/.ssh && cat config", "cd ~ && cat .claude.json", "cat ~/.claude/settings.json", "git show HEAD:.env", "grep -r x --file=.env",
    "cat cy.db", "ls ~/.cy-agent",
    "echo $(rm x)", "echo `rm x`", "cat <(ls)", "cat < a", "cat <<EOF", "echo $HOME", "echo \"$HOME\"", "ls | tee x", "ls | xargs rm",
    "FOO=1 ls", "sudo ls", "env ls", "/bin/ls", "./script.sh", "ls & rm x", "ls &", "(ls)", "ls\nrm x", "ls # x", "{ ls; }",
    "sort -o out a", "sort a --output=b", "uniq a b", "tree -o out", "rg --pre cat x", "jq -n env", "jq '$ENV'",
    "git -c core.pager=sh log", "git --git-dir=/x log", "git log --output=x", "git diff --ext-diff", "cd -", "cat *", "cat .e*",
    "ls &&", "&& ls", "ls ;; ls", "'unterminated", "", "  ", "ls |& cat",
  ]) assert.ok(!ro(c), c);
});

test("cd 로 옮긴 위치까지 따라가서 비밀 경로를 본다 · isSecret 주입", () => {
  assert.ok(!isReadOnlyBash("cd /Users/u/.cy-agent && cat config.json", { ...ctx, isSecret: (p) => p === "/Users/u/.cy-agent/config.json" }));
  assert.ok(!isReadOnlyBash("cat x", { ...ctx, isSecret: (p) => p.endsWith("/x") }));
  assert.ok(isReadOnlyBash("cd sub && cat x", { ...ctx, isSecret: (p) => p === "/Users/u/code/app/x" }));
  assert.ok(!isReadOnlyBash("cd sub && cat x", { ...ctx, isSecret: (p) => p === "/Users/u/code/app/sub/x" }));
});

test("낱말 나누기: 따옴표·이스케이프 풀기, 리디렉션은 /dev/null·fd 만", () => {
  assert.deepEqual(splitReadOnly("git log --oneline | head -3")?.map((s) => s.map((w) => w.text)), [["git", "log", "--oneline"], ["head", "-3"]]);
  assert.deepEqual(splitReadOnly("cat 'a b' \"c d\" e\\ f 2>/dev/null")?.map((s) => s.map((w) => w.text)), [["cat", "a b", "c d", "e f"]]);
  assert.equal(splitReadOnly("ls *.ts")?.[0][1].glob, true);
  assert.equal(splitReadOnly("ls '*.ts'")?.[0][1].glob, false);
  assert.equal(splitReadOnly("ls 2>&1 >/dev/null")?.[0].length, 1);
  assert.equal(splitReadOnly("ls > out"), undefined);
});

test("모드별 데이터 폴더(~/.cy-agent-work · ~/.cy-agent-personal)도 읽기 전용으로 보지 않는다", () => {
  for (const c of ["ls ~/.cy-agent-work", "ls ~/.cy-agent-personal", "cat ../.cy-agent-work/cy.db", "cd ~/.cy-agent-personal && ls"]) assert.ok(!ro(c), c);
  assert.ok(ro("ls cy-agent-work-notes"));
});
