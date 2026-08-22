# RUN_AUTONOMOUS.md — تشغيل ذاتي بلا توقف

**الهدف:** أمر واحد، تتركه يعمل، تعود لتجد النتيجة. بلا أسئلة، بلا مراحل، بلا مراجعة بشرية.

---

## الحقيقة الوحيدة التي يجب أن تعرفها قبل التشغيل

يمكنك إخراج نفسك من الحلقة. **لا يمكنك إخراج التحقق من الحلقة.**

الفرق جوهري: "الذكاء الاصطناعي يراجع نفسه" ليس تحققاً — لأن تقرير الوكيل عن عمله **غير دقيق في نحو 23% من الحالات**. الراوي الذي تعتمد عليه هو أحد الأشياء التي تفشل. سيكتب لك "تم بنجاح" وهو مخطئ، ولن تعرف.

**البديل الصحيح ليس مراجعة بشرية ولا مراجعة ذاتية — بل تحقق آلي:**

| بديل المراجعة البشرية | لماذا يعمل بلا مبرمج |
|---|---|
| **الاختبارات هي الحَكَم** | الاختبار إما أخضر أو أحمر. لا رأي فيه ولا سرد |
| **CI يمنع التقدّم** | كود فاشل لا يُدمج، بغض النظر عما يقوله الوكيل |
| **مراجع عدائي بسياق نظيف** | وكيل ثانٍ لم يكتب الكود ولا يدافع عنه |
| **قائمة فحص تشغيلية على هاتفك** | أنت تجرّب التطبيق كمستخدم، لا كمبرمج |

الملف الثاني (`ACCEPTANCE_CHECKLIST.md`) هو حصتك من التحقق: **صفر قراءة كود، كلها ضغطات على الهاتف.**

---

## 1. التجهيز — مرة واحدة

### لماذا Docker إلزامي

الوضع الذاتي يمنح الوكيل صلاحية تنفيذ أي أمر على جهازك بلا استئذان. داخل حاوية، أسوأ ما يمكن أن يحدث هو تلف الحاوية. خارجها، ملفاتك كلها في مدى الضرر.

**لا تشغّله على جهازك مباشرة. هذه ليست نصيحة احترازية — الأداة نفسها ترفض العمل بصلاحيات root لهذا السبب.**

`Dockerfile`:
```dockerfile
FROM node:22-slim
RUN npm install -g @anthropic-ai/claude-code \
 && apt-get update && apt-get install -y git curl jq \
 && rm -rf /var/lib/apt/lists/*
RUN useradd -m -s /bin/bash agent
USER agent
WORKDIR /work
```

```bash
docker build -t rideapp-agent .
```

### نقطة الحفظ قبل البدء
```bash
git add -A && git commit -m "checkpoint: pre-autonomous-run"
```
أرخص تأمين ممكن. إن خرج الأمر عن السيطرة: `git reset --hard HEAD`.

---

## 2. سكربت التشغيل الذاتي

**لماذا حلقة وليس برومبت واحد عملاق:** البرومبت الواحد يملأ نافذة السياق ثم تنهار جودته بصمت — يبدأ بتعديلات متناقضة ويعيد كتابة ما أنجزه. الحلقة تعطي **سياقاً نظيفاً لكل مهمة**، والحالة تُحفظ في ملفات لا في الذاكرة.

من ناحيتك: أمر واحد، ثم تنصرف. هذا بالضبط ما طلبته.

`run.sh`:
```bash
#!/usr/bin/env bash
set -uo pipefail

MAX_ITERATIONS=120
ITERATION_TIMEOUT=45m
CONSECUTIVE_FAILURES=0

for i in $(seq 1 $MAX_ITERATIONS); do
  echo "=== iteration $i / $MAX_ITERATIONS — $(date -u) ==="

  timeout $ITERATION_TIMEOUT claude -p "$(cat AGENT_LOOP_PROMPT.md)" \
    --permission-mode bypassPermissions \
    --output-format text \
    2>&1 | tee -a logs/run.log

  EXIT=$?

  if [ $EXIT -ne 0 ]; then
    CONSECUTIVE_FAILURES=$((CONSECUTIVE_FAILURES + 1))
    echo "!!! non-zero exit ($EXIT), consecutive=$CONSECUTIVE_FAILURES"
    [ $CONSECUTIVE_FAILURES -ge 3 ] && { echo "ABORT: 3 consecutive failures"; break; }
    sleep 60
    continue
  fi
  CONSECUTIVE_FAILURES=0

  if grep -q "^ALL_TASKS_RESOLVED" STATUS.txt 2>/dev/null; then
    echo "=== agent reports completion at iteration $i ==="
    break
  fi
done

echo "=== run ended $(date -u) — read FINAL_REPORT.md ==="
```

```bash
mkdir -p logs
docker run --rm -v "$PWD":/work rideapp-agent bash run.sh
```

### الضوابط الثلاثة الإلزامية

| الضابط | القيمة | ماذا يمنع |
|---|---|---|
| `timeout 45m` لكل دورة | 45 دقيقة | وكيل عالق يعمل إلى ما لا نهاية |
| `MAX_ITERATIONS=120` | 120 | حلقة لا تنتهي |
| 3 إخفاقات متتالية → توقف | 3 | حلقة إعادة محاولة تحرق 100$ في الساعة |

**ضع سقفاً للإنفاق أيضاً.** إن كنت على API استخدم حد ميزانية؛ إن كنت على اشتراك Max ستصطدم بحدود الجلسة وتستأنف الحلقة تلقائياً. الاشتراك أأمن مالياً هنا تحديداً — لأن الحلقة الذاتية لا يوجد فيها من يوقفها عند الفاتورة.

---

## 3. البرومبت الذاتي

احفظه باسم `AGENT_LOOP_PROMPT.md` في جذر المستودع.

```
You are operating fully autonomously. No human will answer questions, approve
plans, or review your code. Never ask a question. Never wait. Never stop to
request confirmation. If you would normally ask, choose the option most
consistent with CLAUDE.md, record the decision in DECISIONS.md, and proceed.

Read CLAUDE.md first. It is binding and overrides anything below.

=== BOOTSTRAP (only if TASKS.md does not exist) ===
If TASKS.md is absent, this is iteration 1. Do only this, then stop:
1. Produce docs/schema.sql, docs/api-contract.yaml, docs/state-machine.md
   per CLAUDE.md. Scaffold the repo, Docker Compose, CI, Makefile.
2. Produce TASKS.md: an ordered checklist where every task is completable in
   under 45 minutes and independently testable. Format each line exactly:
   - [ ] T001 | <area> | <one-line description> | depends: T000
   Include tasks for: auth, ride lifecycle, atomic matching, realtime,
   rider app, driver app, background location, ledger, admin panel,
   load test, security audit. Nothing outside CLAUDE.md §2 scope.
3. Create STATUS.txt containing: BOOTSTRAP_DONE
4. Write PROGRESS.md — in ARABIC, for a non-programmer. Explain in plain
   language what was set up and what happens next. No jargon.
Then exit. Do not start implementing.

=== MAIN LOOP (every subsequent iteration) ===
Read TASKS.md. Select the FIRST task that is neither [x] nor [BLOCKED] and
whose dependencies are all [x]. Work on that ONE task only. Ignore all others.

For that task:
1. Write the failing tests first. For anything touching matching, ride state,
   or money, include: the concurrent case, the duplicate-idempotency-key case,
   the network-drop case, and the invalid-transition case.
2. Implement the minimum code to pass. No extra features. No scaffolding for
   future work.
3. Run: make test && make lint && make typecheck
4. If ALL pass:
   - git add -A && git commit with a Conventional Commit message
   - mark the task [x] in TASKS.md
   - append one plain-ARABIC sentence to PROGRESS.md describing what a user
     can now do that they could not before
5. If ANY fail:
   - Fix and re-run. Maximum 3 attempts.
   - After 3 failed attempts: mark the task [BLOCKED] in TASKS.md, append the
     exact failing output to BLOCKED.md, git commit the work-in-progress on a
     branch named blocked/<taskid>, and MOVE ON to the next task.
   - Never delete, skip, or weaken a test to make the suite pass. Never mark a
     task [x] with failing tests. This is the one rule that has no exception.

=== SELF-CHECK — run at the END of every iteration ===
Before exiting, verify and record in VERIFY.md the ACTUAL command output for:
- make test  (paste the real summary line, not a paraphrase)
- git status --short  (must be clean)
- count of [x], [ ], and [BLOCKED] in TASKS.md
Do not summarize. Paste output. If your summary and the output disagree,
the output is correct.

=== COMPLETION ===
When every task is [x] or [BLOCKED], perform these three final passes, each
starting from a fresh reading of the codebase, then write ALL_TASKS_RESOLVED
to STATUS.txt:

PASS 1 — Adversarial audit.
Adopt this stance: you did not write this code, you are paid to find reasons
it must not go live, and being agreeable is failure. Audit against CLAUDE.md
§12 line by line. Write DEFECTS.md with: severity (P0 loses money or data /
P1 breaks a live ride / P2 degrades / P3 debt), file, what breaks, trigger,
fix effort. Specifically construct concrete attack cases for: double-accept
interleaving, unbalanced ledger entries, driver A reading driver B's data,
rider A reading rider B's rides, float in any money path, PII in logs.

PASS 2 — Fix every P0 and P1 found in PASS 1. Re-run the full suite. If a P0
cannot be fixed in 3 attempts, leave it in DEFECTS.md marked UNFIXED and say
so loudly in the final report.

PASS 3 — FINAL_REPORT.md, written in ARABIC for a non-programmer:
- What works, in terms of what a user can do
- What does not work, in plain language, no euphemism
- Every UNFIXED P0/P1, described as a real-world consequence
  (e.g. "two drivers can be sent to the same rider" — not "race condition")
- Every task left [BLOCKED] and what it means for the product
- The exact commands the owner must run to verify, with expected output
- An explicit sentence stating whether this is safe to give to real drivers
  and real passengers carrying real money. If the honest answer is no, say no.

=== ABSOLUTE CONSTRAINTS ===
- Never report success when tests fail.
- Never write "production-ready" anywhere. You are not qualified to judge that
  without human review, and no human is reviewing.
- Never push to a remote. Never force-push. Never touch production data.
- Never modify a file outside this repository.
- Never commit secrets, real phone numbers, or API keys.
- If you catch yourself about to ask a question, write it to DECISIONS.md with
  the choice you made instead, and continue.
```

---

## 4. ما تجده حين تعود

| الملف | اللغة | لماذا تقرأه |
|---|---|---|
| **`FINAL_REPORT.md`** | عربي | **ابدأ من هنا.** الحكم النهائي بلغة غير تقنية |
| `PROGRESS.md` | عربي | سطر لكل ميزة أُنجزت |
| `DEFECTS.md` | إنجليزي | العيوب. ركّز على P0 و P1 فقط |
| `BLOCKED.md` | إنجليزي | ما عجز عنه — وهذا أصدق مؤشر على الحالة |
| `VERIFY.md` | مخرَج خام | **الحقيقة الوحيدة غير القابلة للتلاعب** |
| `TASKS.md` | مختلط | عدّ `[x]` مقابل `[BLOCKED]` |

**القاعدة الذهبية للتحقق:** إن تعارض `FINAL_REPORT.md` مع `VERIFY.md`، فـ `VERIFY.md` هو الصحيح. الأول سرد، والثاني مخرَج آلة.

---

## 5. ملف التوقعات الصادق

هذا ما يحدث فعلياً في التشغيل الذاتي الطويل، لا ما نتمناه:

| الاحتمال | الحدث |
|---|---|
| **مؤكد** | بعض المهام ستنتهي `[BLOCKED]`. هذا نجاح للنظام لا فشل — البديل حلقة لا نهائية |
| **مرجّح جداً** | تصليب الموقع الخلفي (Doze) سيُنجز نظرياً ويفشل على هاتف حقيقي. لا يمكن اختباره بلا جهاز |
| **مرجّح** | التقرير النهائي سيكون متفائلاً أكثر من الواقع بدرجة ما |
| **وارد** | دورة أو دورتان تُهدران في حلقة إصلاح متذبذب قبل أن يوقفها حد الثلاث محاولات |
| **مستحيل** | أن يخرج منتج تجاري جاهز بلا أي تحقق منك |

**النقطة الأخيرة ليست تحفّظاً قانونياً.** التطبيق يضع غرباء في سيارات معاً ويحرّك أموالاً. خطأ صلاحيات واحد يعني أن سائقاً يرى موقع سائق آخر وبيانات ركّابه. الاختبارات تكشف هذا **إن كُتبت**، والمراجع العدائي يكشفه **إن نجح**. القائمة في `ACCEPTANCE_CHECKLIST.md` هي الشبكة الأخيرة، وهي مصمّمة لغير المبرمجين تحديداً — **ست فحوصات، كلها من هاتفك، بلا سطر كود واحد.**

نفّذها. هي الفرق بين تجربة ناجحة وبين اكتشاف المشكلة من سائق غاضب.
