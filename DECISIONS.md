# DECISIONS.md

Decisions taken without asking, as `AGENT_LOOP_PROMPT.md` requires. Each records
the choice, the reasoning, and what would change it.

---

### D-001 — `jose` for JWT and Firebase verification, not `firebase-admin`

**Chose:** verify Firebase ID tokens by checking RS256 signatures against
Google's published JWKS, using `jose`; issue our own tokens with the same
library.

**Why:** `firebase-admin` is a very large dependency that pulls in gRPC and a
Google Cloud client stack, for one function — validating a signed JWT. On a
4-core VPS (CLAUDE.md §3) that is memory and cold-start cost for nothing.

**Risk:** we implement issuer/audience/expiry checks ourselves and must get them
right. Mitigated by keeping the verifier behind a port with a deterministic fake,
so the checks are unit-testable.

**Reverse it if:** Firebase adds a verification step that is not plain JWKS.

---

### D-002 — money is a branded `number`, not `bigint`

**Chose:** `IqdAmount = number & brand`, validated as a safe integer, with
`MAX_IQD = 100,000,000,000`.

**Why:** CLAUDE.md §6.1 mandates `BIGINT` in the database, which is about storage
and is honoured. In TypeScript, `bigint` does not survive `JSON.stringify`, does
not mix with `number` in arithmetic without explicit casts, and would put a
conversion at every boundary — each one a chance to reintroduce a float. A
branded integer keeps arithmetic ordinary while making an unvalidated `number`
un-assignable.

**Guard:** the largest realistic value (a wallet balance) is ~7 orders of
magnitude below `Number.MAX_SAFE_INTEGER`. `assertBpsPrecisionInvariant()` fails
at import if `MAX_IQD` is ever raised past the point where commission arithmetic
stops being exact.

**Reverse it if:** the platform ever handles a currency with subunits, or
balances approach 2^53.

---

### D-003 — the ledger's cash-ride model

**Chose:** a completed cash ride writes

```
DRIVER_CASH_HELD   DEBIT   fare         driver is holding this cash
PLATFORM_REVENUE   CREDIT  commission   omitted entirely when commission is 0
DRIVER_WALLET      CREDIT  earnings     fare - commission
```

**Why:** it nets to zero by construction, and it stays balanced with only two
rows at the shipped default of 0 bps (CLAUDE.md §6.5) — which matters, because
the schema forbids a zero-amount row, so a three-row shape would break at the
default configuration.

**Consequence to be aware of:** `DRIVER_WALLET` therefore reads as *cumulative
driver earnings plus manual adjustments*, not as "money the platform is holding
for the driver". With cash payment the driver already has the money. An operator
reading the admin panel must understand the wallet as an earnings ledger.

**Reverse it if:** the platform starts actually holding driver funds (a real
gateway), at which point the wallet becomes a liability account and this model
needs revisiting before launch, not after.

---

### D-004 — the fare estimate is a floor at settlement

**Chose:** `settle()` recomputes from the odometer distance and takes the
**higher** of that and the original estimate.

**Why:** the rider agreed to a quoted price. Charging less than the quote when
the trip ran short would make every quote a maximum rather than a price, and
drivers would be paid less than they were promised for accepting.

**The alternative** — always charge exactly the quote — is equally defensible
and simpler to explain to riders. This is a business decision recorded as a
technical one, and it is isolated to a single method so it can be changed with
one edit and one test update.

**Flag for the owner:** this is worth an explicit decision before real drivers
use it.

---

### D-005 — `ROAD_DISTANCE_FACTOR = 1.35`

**Chose:** estimate road distance as straight-line × 1.35.

**Why:** CLAUDE.md §3.2 forbids a synchronous routing call in a request handler,
so a quote cannot use a real route. 1.35 is a common approximation for a dense
city.

**This is the least defensible number in the codebase.** Baghdad's river
crossings make it optimistic for some trips and pessimistic for others. It is a
named constant in one file with its own test so that the day real trip data
exists, it can be replaced by a fitted value.

---

### D-006 — an in-memory Redis for unit tests, held to a conformance suite

**Chose:** a `RedisPort` with two implementations, and one shared conformance
suite run against both.

**Why:** CLAUDE.md §10 requires the concurrent case to be tested at 95%.
Driving a true 50-way race against a real Redis from a unit test is slow and
non-deterministic; against an in-process implementation it is exact and
repeatable.

**The obvious objection** — that this proves the fake correct rather than the
system — is why the conformance suite exists and why it is a single shared file.

**Unresolved on this host:** the real-Redis half skipped, because there is no
Redis. See `BLOCKED.md`. This is the most important open item in the repo.

---

### D-007 — 404, not 403, for a ride belonging to someone else

**Chose:** `GET /rides/{id}` returns 404 both when the ride does not exist and
when it exists but belongs to another user.

**Why:** distinguishing them turns the endpoint into an oracle for which ride
ids are real. `ACCEPTANCE_CHECKLIST.md` check 5 is about not leaking other
people's data, and the id itself is data.

---

### D-008 — the counterparty type has no phone field at all

**Chose:** `PublicUser` in the API contract has no `phone` property, rather than
a phone that is filtered out.

**Why:** `ACCEPTANCE_CHECKLIST.md` check 5 asks whether the rider's number is
visible to the driver after the trip. A filter is a line of code someone can
remove; an absent field is a compile error. The only schema carrying a phone is
`Me` (your own) and `AdminDriver` (admin-only).

---

### D-009 — `EXPIRED` re-drives inside one transaction, with a sweeper behind it

**Chose:** `OFFERED → EXPIRED` is immediately followed by `EXPIRED → REQUESTED`
or `EXPIRED → NO_DRIVERS_FOUND` in the same DB transaction, plus a sweeper for
rides left in `EXPIRED` for more than 60s.

**Why:** CLAUDE.md §4 lists `EXPIRED` as a state and requires every transition to
be recorded, so it cannot be skipped. But a ride resting in `EXPIRED` is
invisible to matching, and the rider waits forever. The sweeper covers the only
way that can happen — a worker dying mid-transaction.

---

### D-010 — `run.sh` differs from the listing in `RUN_AUTONOMOUS.md`

**Changed:** `EXIT=$?` became `EXIT=${PIPESTATUS[0]}`.

**Why:** the original assigns the exit status of `tee`, which is the last command
in the pipeline and essentially always 0. The "3 consecutive failures → abort"
guard — one of the three mandatory controls in `RUN_AUTONOMOUS.md` §2 — would
therefore never have fired, and a failing loop would have run all 120 iterations.

This is a change to a file the owner wrote, so it is flagged rather than made
silently. The behaviour now matches what the document says it does.

---

### D-011 — `require-await` disabled in `in-memory-redis.ts`

**Chose:** a file-level eslint disable with an explanatory comment.

**Why:** every method is `async` with no `await` deliberately. Running to
completion with no suspension point is what reproduces Redis's single-threaded
atomicity; adding an `await` to satisfy the rule would insert a microtask
boundary into every read-modify-write and destroy the property the
double-accept tests depend on.

---

### D-012 — integration tests skip rather than fail without their services

**Chose:** `test/integration/*` skips when `TEST_REDIS_URL` / `TEST_DATABASE_URL`
are unset.

**Why:** `make test` must stay runnable on a laptop with no Docker; a suite that
is red for environmental reasons trains people to ignore red.

**The cost, stated plainly:** if CI does not set those variables, these tests
never run anywhere and their absence is silent. The CI workflow must set them.
Until CI exists (T041), **they have run nowhere.**

---

### D-013 — Stack: KEEP the existing repository stack (OWNER DECISION, 2026-08-23)

**Chose:** Flutter (rider + driver) · NestJS (API) · Refine/React (admin) · raw
`pg` with hand-written SQL. **No migration.**

**Who decided:** the owner, explicitly. This was `BLOCKER-1`, recorded as
*BLOCKED — OWNER DECISION REQUIRED*. It is now **decided and closed.**

**What this settles:** the original product brief named Kotlin/Compose, Next.js,
and Prisma/TypeORM. The repository is authoritative instead. The conflict is
**documented, not acted on** — no Dart file is deleted, no Kotlin module is
created, and `CLAUDE.md` §1 is left exactly as written.

**What it does NOT settle:** the mobile apps still have never been compiled.
Keeping Flutter removes the *architectural* blocker; the *environment* blocker
(no Flutter SDK, BLOCKER-4) is untouched. Nothing moves to `DONE` because of
this decision.

---

### D-014 — Scope: conflicting features stay PENDING (OWNER DECISION, 2026-08-23)

**Chose:** KYC, driver approval, surge, zones, and promotions are marked
**SCOPE DECISION PENDING**. Not built, not deleted, not scaffolded.

**Why:** the brief §15–16 require them; `CLAUDE.md` §2 lists all five as OUT OF
SCOPE and §12.7 forbids scaffolding them "for later". Building them would
violate the constitution; deleting the requirement would hide the brief.

**Explicitly NOT done:** `CLAUDE.md` was not edited to make the conflict
disappear, and no placeholder module was created to make the matrix look
complete.

---

### D-015 — Rate limiting: risk-tiered failure policy, not one global policy

**Chose:** the failure behaviour when Redis is unreachable is now a property of
the **endpoint**, not of the limiter. Three tiers — see `docs/RATE_LIMIT_POLICY.md`.

**Why the previous single policy was wrong:** blanket fail-open meant that a
Redis outage removed *all* protection from OTP verification, which costs real
money per call and is an enumeration oracle. Blanket fail-closed is equally
wrong — it converts a Redis blip into "nobody can request a ride", which is a
larger incident than unthrottled OTP.

**Neither extreme was adopted.** The critical tier degrades to a stricter
in-process limiter rather than failing open or shut.

---

### D-016 — البقاء على Flutter رغم أن خطة درب v3 تقول ويب أولاً (قرار المالك، 2026-08-23)

**Chose:** إكمال المشروع الحالي بـ Flutter الأصلي كما ينص `CLAUDE.md` §1.

**السياق الذي ظهر:** مسح الجهاز كشف خمسة مشاريع نقل سابقة، ومعها
`خطة-درب-v3.md` بخط المالك تنص صراحةً: *«درب تطبيق ويب (React+Vite) يعمل من
المتصفح مباشرة — لا يحتاج متجر تطبيقات في هذه المرحلة إطلاقاً.»*

**لماذا كان القرار مهماً:** أكبر ثلاث عقبات مفتوحة في هذا المستودع — مشاريع
أندرويد (M-1)، ومتجر Play، واختبار الجهاز الحقيقي لـ §5.3 — كلها تختفي في
مسار الويب. القرار كُلّف صراحةً للمالك لهذا السبب، وليس لأنه تفصيل تقني.

**الثمن المقبول بوعي:** يبقى مطلوباً تفريغ ~10 GB، وتثبيت Flutter SDK، وأول
ترجمة لـ 27 ملف Dart لم يمر عليها مترجم قط (مدة غير معروفة)، ثم جهاز حقيقي.

**ما لم يحدث:** لم يُحذف أي كود Dart، ولم يُنسخ أي كود من المشاريع الخمسة —
فهي React Native و Kotlin و React، والنقل منها إعادة كتابة لا إعادة استخدام.
انظر `docs/PRIOR_PROJECTS.md`.

---

### D-017 — نموذج الدخل: مؤجَّل بقرار المالك (2026-08-23)

**Chose:** لا تغيير في الكود الآن. `commission_bps` يبقى قابلاً للضبط
وافتراضيه صفر، ولا يُبنى نظام التبرعات.

**التعارض المسجَّل:** `خطة-درب-v3.md` تعلن **«صفر عمولة، للأبد، لا يملك أحد
تغييره»** كهوية للمنتج لا كإعداد، ودخلاً من **تبرعات طوعية عبر زين كاش** مقابل
وسام «داعم» بلا أي أولوية رحلات، مع صفحتي `/pricing` و`/transparency`.

بينما `CLAUDE.md` §6.5 يجعل العمولة **إعداداً** قابلاً للتغيير بلا نشر.

**تصحيح لازم:** في جولة سابقة وصفتُ العمولة الصفرية بأنها إغفال يمنع الربح.
كان ذلك خطأً في التأطير — الوثيقة تُظهر أنها قرار هوية مقصود. المسجَّل هنا هو
التعارض، لا ترجيح أحد الطرفين.

**غير محسوم عمداً**، مثل BLOCKER-2. لم تُعدَّل `CLAUDE.md` لإخفاء التعارض، ولم
يُبنَ نظام تبرعات لم يُطلب.

---

### D-018 — وثائق السائق (KYC): بُنيت بقرار المالك، معطّلة افتراضياً (2026-08-24)

**Chose:** بناء بنية تحقق من وثائق السائق، **قابلة للتفعيل من الإعدادات
وافتراضها معطّل تماماً**.

**التعارض المسجَّل:** `CLAUDE.md` §2 يضع «Driver KYC/document upload» في قائمة
OUT OF SCOPE، و§12.7 يمنع سقالات الميزات خارج النطاق، و§0 يُلزمني بالتوقف
والسؤال قبل الكتابة. رُفع التعارض في جولتين سابقتين تحت اسم BLOCKER-2 ولم
يُبنَ شيء. في هذه الجولة أعطى المالك القرار صراحةً، فبُني.

**ما بُني بالضبط:**

- `driver_documents` — سجل واحد لكل (سائق، نوع وثيقة). أربعة أنواع.
- نقطتا فرض: رفض الاتصال بالشبكة، واستبعاد من المطابقة.
- مساران للإدارة لتسجيل نتيجة الفحص، مع أثر في `audit_log`.

**ما رُفض بناؤه، ولماذا:**

| البند | السبب |
|---|---|
| **رفع الصور** | §2 يمنعه، والحقول المطلوبة كلها بيانات وصفية لا صور. تخزين الصور سطح مستقل: PII على القرص، نسخ احتياطي، استبقاء. |
| **أصناف المركبات** | `multiple vehicle classes` في قائمة OUT. عمود بقيمة واحدة كود ميت. |
| **أي وثيقة إلزامية افتراضياً** | ما تشترطه القوانين العراقية سؤال قانوني. الافتراض `''` — والاختبار الذي يحرسه يقرأ ملف الترحيل نفسه. |

**الخاصية الحاملة:** «معطّل» يعني **غياب الفحص** لا سياسة تسمح للجميع — قائمة
فارغة ← لا استعلام إطلاقاً. يحرس ذلك اختباران: واحد يؤكد صفر استعلامات، وآخر
يؤكد أن السائق يتصل بالشبكة تماماً كما قبل.

**لا يزال معلّقاً:** أي الوثائق تُفعَّل فعلياً. ذلك قرار قانوني، والكود لا يتخذه.

---

### D-019 — رافد التحصيل: السؤال مسجَّل، والنطاق **غير** ممنوح (2026-09-05)

**Chose:** لا تُعدَّل `CLAUDE.md` §2 ولا §7 الآن. يبقى ربط أي بوابة دفع حيّة
خارج النطاق، ويبقى `GatewayProvider` مجرد stub. يُسجَّل السؤال وشرط إعادة فتحه.

**السياق:** طرح المالك بحثاً عن **Wayl** (مجمِّع مدفوعات عراقي، بغداد) كرافد
محتمل لتحصيل اشتراكات الكباتن. دُقِّق المستودع كاملاً مقابل ذلك السيناريو.

**لماذا لا يُمنح النطاق اليوم:**

- توسعة 2026-08-25 أدخلت الاشتراكات ولم تمسّ §2:90 ولا §7 — رغم أنها حرّرت
  نفس القسم في نفس اليوم. الصمت ليس إذناً ضمنياً (§2:95، §0).
- **لا شيء بين اليوم وذلك الربط يتوقف على هذا التعديل.** كل ما يحتاجه المشروع
  الآن — بيع اشتراك نقداً — داخل النطاق أصلاً بلا حرف واحد من التعديل.
- §12.7 يمنع السقالات. تعديل مفتوح اليوم يجعل أي جلسة قادمة تظنّ الربط مسموحاً
  فتبني نصفه وتتركه.

**ما يُطلق إعادة الفتح:** وجود **~50 كابتناً يدفع اشتراكه نقداً فعلاً**. قبل
ذلك لا توجد إيرادات تبرّر كلفة تسجيل وامتثال، وهو بالضبط عكس مبدأ بوابات
الانتقال الذي بُني عليه المنتج.

**وحين يُعدَّل، تكون الصيغة موصوفة بالآلية لا بالمورّد:**

> §2 — يُسمح برافد تحصيل حيّ **واحد**، لشحنات جهة الكابتن حصراً. أجرة الراكب
> تبقى نقداً.
> §7 — `GatewayProvider` يبقى stub؛ الرافد يُنفَّذ كمزوّد منفصل ولا يمرّ عبر
> مسار الرحلة.

اسم المورّد لا يدخل الدستور: شروط Wayl تسمح بالتعليق أو الإنهاء «مع أو بدون
سبب، ومع أو بدون إشعار». تسمية مورّد في وثيقة تعريفية تجعل استبداله تعديلاً
دستورياً بدل أن يكون تبديل ملف.

**قرار معماري مسبَّق، ليُوفَّر على الجلسة القادمة اكتشافه:** الرافد — أياً كان
المورّد — يُبنى **بالاستعلام الدوري لا بـ webhook**:

```
طلب شراء → BullMQ ينشئ رابط الدفع → التطبيق يفتحه خارجياً (url_launcher)
→ job دوري يستعلم حالة الرابط → WebSocket/FCM يبلّغ التطبيق
```

يحترم ذلك §3.2 (لا نداء خارجي متزامن في request handler)، ويُسقط: تعديل
`payment_method` ENUM، و`ALTER TYPE` غير القابل للعكس في PostgreSQL، والـ
endpoint العام غير المصادَق، **وثغرة الـ replay بالكامل** — وتوقيع Wayl لا
يحمل طابعاً زمنياً، فالطلب الملتقط يبقى صالحاً للإعادة إلى الأبد، والمستودع لا
يملك أي دفاع اليوم (انظر التصحيح في `docs/security-audit.md` S-2).

**ما لم يكن سؤال مدفوعات أصلاً:** التسجيل. `docs/IRAQ_REGULATORY.md` §1 يسجّل
منذ 2026-08-24 أن مشغّل النقل نفسه يُفاد بحاجته لتسجيل رسمي. وصل السؤال من جهة
Wayl فبدا سؤالاً عن الدفع، وهو ليس كذلك: قيد الترخيص يسبق قيد المجمِّع بكثير.
رُقّي إلى السؤال الأول على قائمة المحامي هناك.

**Reverse it if:** بلغ العدد ~50 كابتناً دافعاً، **أو** تبيّن أن التحصيل
النقدي اليدوي لا يتوسّع قبل ذلك.

---

### D-020 — `commission_bps` تبقى صفراً لأنها غير قابلة للتحصيل، لا لأنها منسيّة (2026-09-05)

**Chose:** يبقى `commission_bps = 0`. نموذج الدخل المبنيّ أولاً هو **الاشتراك**،
لا العمولة. يُغلق هذا الشقّ التقني من D-017 دون أن يحسم هويّة المنتج فيه.

**تصحيح لجولة سابقة في هذه الجلسة:** وصفتُ العمولة بأنها «رافعة إيراد مبنية
بالكامل تنتظر رقماً»، ورتّبتها قبل الاشتراك. ذلك صحيح تقنياً ومضلِّل اقتصادياً.

**السبب:** مع الأجرة نقداً، **العمولة غير قابلة للتحصيل**. الكابتن يمسك النقود.
و`DRIVER_WALLET` — بنصّ D-003 — «أرباح تراكمية»، لا فلوس تحتفظ بها المنصة. فرفع
العمولة فوق الصفر يُنشئ ذمّة على الكابتن **بلا أي آلية تحصيل**، ويجعله يراكم
ديناً لم يوافق عليه ولا يستطيع رؤيته. هذه مشكلة ثقة بالمنتج قبل أن تكون نقصاً
تقنياً.

**والاشتراك عكسه بالضبط:** إنفاذه هو **«لا تدخل أونلاين»** — وهذه آلية مبنية
ومختبَرة فعلاً في `CapabilityService`. فهو نموذج الدخل الوحيد الذي تستطيع منصة
نقدية إنفاذه.

| | العمولة | الاشتراك |
|---|---|---|
| جاهزية تقنية | مبنية بالكامل | صفر سطر بيع |
| قابلية التحصيل نقداً | **مستحيلة** | ممكنة |
| آلية الإنفاذ | «أنت مدين لنا» — لا توجد | «لا تدخل أونلاين» — موجودة |

**السعر المختار: 25,000 د.ع شهرياً، خطة واحدة، والسياسة مُطفأة عند البناء.**

- 50,000 أرخص برسوم أي مجمِّع (3.7% مقابل 4.9%) لكنها ~10 رحلات شهرياً. 25,000
  ≈ 5 رحلات. **رسوم المزوّد ليست القيد الملزم عند صفر كابتن — اكتساب العرض هو.**
- خطة واحدة: تعدّد الخطط قرار تسعير بلا بيانات تسنده بعد.
- `subscription_required` يبقى `false`: تُبنى الآلية وتُختبر قبل أن تضطر للعمل.
  سابقة قائمة — 0010 و0011 كلاهما مزروع `false`.

**شرط مسبق فُرض على النفس:** قبل بناء أي رافد إيراد، يجب أن يصير
`PLATFORM_REVENUE` **قابلاً للقراءة**. كان للكتابة فقط: `balanceFor` و
`entriesFor` كلاهما يثبّت `DRIVER_WALLET`، فلا تقرير يقرأ إيراد المنصة. بناء
رافعة دخل لا تُرى ليس بناء دخل.

**ما لم يُحسم:** التعارض المسجَّل في D-017 — `خطة-درب-v3.md` تعلن «صفر عمولة،
للأبد» كهوية للمنتج بينما §6.5 يجعلها إعداداً. هذا القرار **لا يرجّح** ذلك
الطرف: يقول فقط إن العمولة تبقى صفراً لسبب تشغيلي مستقل. إن حُسمت الهوية لاحقاً
لصالح «صفر للأبد»، فهذا القرار يظلّ صحيحاً بسبب مختلف.

**Reverse it if:** توقّف الدفع النقدي عن كونه الوضع الافتراضي، أي ظهر مسار
تحصيل يجعل ذمّة العمولة قابلة للتحصيل فعلاً.

---

### D-021 — المفاوضة: وُصِلت لا حُذفت، وتبقى مُطفأة (2026-09-05)

**Chose:** ربط `NegotiationService` بوحدة التطبيق وإنشاء `NegotiationController`
للمسارات الثلاثة الموجودة في العقد، وإضافة `proposedFareIqd` إلى `POST /rides`.
تبقى `negotiation_enabled` بقيمة `false`.

**المشكلة:** الخدمة مكتوبة ومختبَرة و**غير مسجَّلة في أي وحدة ولا يعرضها أي
controller**، بينما `docs/api-contract.yaml` يوثّق `/rides/{rideId}/bids` منذ
الترحيل 0012. أي: عقد منشور يَعِد بمسارات تُجيب 404، و~600 سطر كود لا يمكن
بلوغه — وهو ما يمنعه §12.7 صراحةً. وزاد الأمر سوءاً أن اختباراتها التكاملية
تتخطّى نفسها، فلم يُبلِّغ شيء عن الفجوة.

**لماذا الوصل لا الحذف:** الميزة **داخل النطاق** بتوسعة 2026-08-25، و
`negotiation_enabled` مزروعة `false` — فالوصل لا يغيّر شيئاً لأحد حتى يقرّر
المالك تشغيلها، وكل دالة تُجيب 404 قبل ذلك عبر `requireEnabled`.

**ما اكتُشف أثناء الوصل:** المزايدة كانت **غير قابلة للبلوغ بالمعنى الحرفي** حتى
لو شُغّلت — `placeBid` يشترط رحلة تحمل عرضاً، ولا يوجد أي مسار يضع `proposed_fare_iqd`.
فأُضيف الحقل إلى العقد ثم إلى `createRide`، **مقيَّداً** بـ `negotiation_band_bps`
حول سعر العداد: راكب يعرض 500 على رحلة بـ 5,250 لا يفاوض، وسائق يطلب عشرة أضعاف
العداد كذلك.

**قرار داخل القرار:** العرض **يُقصّ** إلى حدّ النطاق ولا يُرفض. راكب كتب 3,000
على رحلة بـ 5,250 قصد «أريدها أرخص»، وردّ التحقق لا يعلّمه ما هو المسموح؛ القصّ
يجعل الحدّ مرئياً في الرقم الذي يعود إليه.

**ملاحظة على الاختبار:** «مُطفأة» تُجيب 404 عمداً حتى لا تُعلن ميزة غير مُطلَقة —
وهذا يجعل «موصولة ومطفأة» و«غير موصولة» **غير قابلتين للتمييز بالحالة**. لذلك
اختبارات e2e تثبت الوصل عبر **تحقق الحدود** (422 لمبلغ كسري) لأن الـ 422 لا
تصدر إلا عن مسار مربوط فعلاً. الجريان نفسه يبقى في `real-negotiation.test.ts`
تحت `REAL_INFRA`.

**Reverse it if:** قرّر المالك أن التسعير بالعداد هو المنتج، فيُحذف كل ما سبق
مع مساراته من العقد — لا يُترك مطفأً إلى الأبد.

---

### D-022 — التسوية تمرّ عبر طبقة §7، لا حولها (2026-09-05)

**Chose:** `RideService.complete` يسوّي عبر
`PaymentProviderRegistry.get(ride.paymentMethod).charge(...)` بدل `INSERT` مباشر
مع `'CASH'` مثبَّتة كنص SQL ونداء مباشر لدفتر الأستاذ.

**لماذا:** `PaymentProviderRegistry` كان مسجَّلاً في الـ DI و**يُحقَن في لا شيء**.
`RideService` يكرّر `CashProvider.charge` سطراً بسطر. النتيجة ليست التكرار — بل أن
الطبقة التي وُجد §7 لإثباتها **لم تحمل ولا دفعة واحدة**، ووعده «إضافة زين كاش =
ثلاث دوال» كان تخميناً غير مُختبَر.

**تغيير واحد في العقد الداخلي:** أُضيف `confirmedAt` إلى `PaymentContext`. كان
`CashProvider` يستعمل `now()` في SQL، بينما الوقت في هذا المستودع **تبعية محقونة**
(`common/clock.ts`) حتى تُختبر مسارات المهل بلا انتظار. طابع زمني واحد خارج هذا
الانضباط — وهو الذي على الفلوس تحديداً — غير مقبول.

**أثر جانبي مفيد:** كشف أن `FakeDatabase` لا يدعم
`INSERT INTO payments ... RETURNING id`، لأن المسار القديم لم يكن يطلب صفاً. أي:
الوهمي كان يخالف PostgreSQL في عمود موجود عند كليهما.

**Reverse it if:** لا شيء. هذا يعيد الكود إلى ما ينصّ عليه §7 أصلاً.

---

### D-023 — دمج `apps/aly`: **إضافي**، والتطبيقان القديمان لم يُحذفا (2026-09-05)

**Chose:** إنشاء `apps/aly` كتطبيق واحد بوضعَي راكب وسائق، **مع إبقاء**
`apps/rider` و`apps/driver` كما هما وبناؤهما في الـCI. لم يُحذف شيء.

**لماذا إضافي:** §1.1 يقول إن التطبيق المدمج يرث معرّف حزمة **الراكب**، وأن حزمة
السائق **تُتقاعد**. تقاعد معرّف حزمة مسجَّل في Firebase ببصمات SHA يصبح **غير
قابل للرجوع بعد أول رفع إلى Play**. حذف التطبيقين الآن يجعل التراجع مستحيلاً
مقابل صفر فائدة — الدمج يُختبر بالكامل وهما قائمان.

**ما وُرِث وما تغيّر:**

| البند | القرار |
|---|---|
| `applicationId` / `namespace` | `iq.rideapp.rideapp_rider` — **بلا تغيير** (CLAUDE.md:29) |
| حزمة Dart | `rideapp_rider` → `rideapp_aly` (شأن داخلي، لا يمسّ Play ولا Firebase) |
| `google-services.json` | ملف الراكب، لأنه المطابق لمعرّف الحزمة الباقي |
| اسم المُشغِّل | **`ALY` / `الي`** — كان `Darb` / `درب`، وهي مخالفة §1 قائمة في التطبيقين |
| البيان (Manifest) | أساسه بيان **السائق** لأنه يحمل آلية §5.3 كاملة، مضافاً إليه ما كان عند الراكب فقط: `taskAffinity=""` واستعلام `PROCESS_TEXT` الذي يحتاجه محرك Flutter |
| التبعيات | اتحاد المجموعتين. الإصدارات كانت متطابقة، فلا تعارض |

**المشكلة الحقيقية التي كشفها الدمج — الهوية:**

الخادم يحلّ الحساب بـ **(هاتف، دور)** لا بالهاتف وحده — `findByPhoneAndRole`.
أي أن رقماً واحداً قد يملك **صفَّي مستخدم مختلفين**. في تطبيقين منفصلين كان هذا
غير مرئي: كل ثنائية تثبّت دورها. تطبيق واحد لا يستطيع تثبيت أيّهما:

- إرسال `RIDER` دائماً يُدخل سائقاً حقيقياً إلى حساب راكب — **ويُنشئه** إن لم
  يكن موجوداً — فلا يبلغ وضع السائق أبداً مهما قال `/me/capabilities`.
- إرسال `DRIVER` دائماً يرفض كل راكب، إذ لا تسجيل ذاتي للسائقين في v1.

**Chose:** المحاولة بـ`DRIVER` أولاً، والرجوع إلى `RIDER` عند «لا يوجد حساب
سائق». الترتيب مقصود: رقم يملك الاثنين يحصل على جلسة السائق، و`canRide` تبقى
`true` لأي حساب فعّال — فيحتفظ بالوضعين. العكس كان سيحبسه في الأقل صلاحية.

⚠️ **الرمز 403 يُبتلع في حالة واحدة فقط:** «لا يوجد حساب سائق». الحساب المعطّل
يُجيب 403 أيضاً، وإعادة السؤال كـ`RIDER` كانت ستُنشئ حساب راكب جديداً لشخص
مُوقَف للتو. لذلك المطابقة على نصّ الخادم، وأي 403 غير معروف **يُعاد رميه**.

**الحل الصحيح** هوية واحدة لكل رقم والقدرات تقرّر الوضع — وهو ما يصفه §1.1
حرفياً. لكنه تغيير مخطط وترحيل على حسابات حيّة، ولا يُتخذ في جلسة غير مراقَبة.
**مرفوع لك.**

**عيب أمسكه المترجم أثناء الدمج:** كتبتُ أولاً
`mode = allowed ? driver : rider`. هذا **يخفض كل سائق انتهى اشتراكه إلى راكب
بصمت** — وهو بالضبط الفشل الذي بُني هذا العمل كله لمنعه. القاعدة الصحيحة:
الوضع يتبع **هل الحساب سائق** (`NOT_A_DRIVER` وحده ينفيه)، لا **هل يُسمح له
الآن**. السائق الممنوع يبقى في وضع السائق ويرى قائمة الأسباب. يحرس ذلك
`test/mode_selection_test.dart` بثمانية اختبارات.

**ما يجب أن تفعله خارج المستودع قبل الإطلاق:**
1. تأكيد أن `google-services.json` في `apps/aly` يطابق معرّف حزمة الراكب.
2. بصمات SHA للإصدار على تطبيق Firebase الخاص بالراكب.
3. قرار متى تُحذف `apps/rider` و`apps/driver` — **بعد** أن يُبنى `apps/aly`
   ويُجرَّب على جهاز حقيقي، لا قبله.

**Reverse it if:** فشل بناء `apps/aly` على جهاز. احذف المجلد؛ لم يُمسّ شيء آخر.
