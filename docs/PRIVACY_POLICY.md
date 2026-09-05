# سياسة الخصوصية — ALY (الي)

**آخر تحديث: ٥ أيلول ٢٠٢٦**

> **للناشر:** Play يشترط أن تكون هذه الوثيقة منشورة على **رابط عام ثابت**
> قبل تقديم التطبيق، وأن يطابق مضمونها استمارة Data safety حرفياً. كل بند
> هنا مشتقّ من الكود لا من قالب — راجع `docs/PLAY_LISTING.md` لملف الإثبات
> لكل ادعاء. **راجعها مع محامٍ قبل النشر**؛ هذه صياغة هندسية دقيقة، وليست
> استشارة قانونية.
>
> الأقواس `[ ]` أدناه هي الحقول الوحيدة التي لا يستطيع الكود ملأها.

---

## من نحن

ALY (الي) خدمة لطلب سيارات الأجرة في بغداد، العراق.

**المشغّل:** [الاسم القانوني أو اسم المالك]
**العنوان:** [العنوان]
**للتواصل بشأن الخصوصية:** [البريد الإلكتروني]

---

## ١. ما الذي نجمعه

### رقم هاتفك
هو هويتك في التطبيق. نستعمله لتسجيل الدخول وللتواصل معك بشأن رحلة.
يُخزَّن بصيغة `+964…`.

التحقق من الرقم يجري عبر **Firebase Phone Auth** من Google، فيصل الرقم إليهم
بصفتهم **معالِج بيانات** ينفّذ العملية نيابةً عنا — لا بصفتهم طرفاً نبيعه
بياناتك أو نشاركها معه لأغراضه.

### اسمك
اختياري. إن تركته فارغاً نسجّلك باسم «راكب». يراه الطرف الآخر في الرحلة فقط
ليعرف بمن يلتقي.

### موقعك

| | الراكب | الكابتن |
|---|---|---|
| أثناء استعمال التطبيق | نعم | نعم |
| **والتطبيق مغلق أو الشاشة مطفأة** | **لا، أبداً** | **نعم، أثناء الاتصال فقط** |

**للراكب:** موقعك يُستعمل لتحديد نقطة الانطلاق وأنت تنظر إلى الشاشة. التطبيق
**لا يطلب ولا يملك** صلاحية الموقع في الخلفية للركاب إطلاقاً.

**للكابتن:** حين تضغط «متصل»، يُرسل موقعك باستمرار حتى وأنت لا تنظر إلى الهاتف
— وإلا رأى الراكب سيارة واقفة لا تتحرك. يعمل ذلك عبر خدمة أمامية بإشعار دائم،
فتعرف دائماً أنها تعمل. **حين تضغط «غير متصل» يتوقف الإرسال.**

### ما لا نجمعه

**لا** بيانات بطاقات أو حسابات مصرفية — الأجرة نقداً بينك وبين الكابتن، والتطبيق
لا يمسّ أي وسيلة دفع · **لا** جهات اتصال · **لا** صور أو ملفات · **لا** رسائل
(لا توجد محادثة داخل التطبيق) · **لا** بيانات صحية · **لا** إعلانات ولا تتبّع
إعلاني.

---

## ٢. لماذا نجمعه

للغرض التشغيلي وحده: مطابقة راكب بكابتن، إظهار موقع السيارة للراكب أثناء
الرحلة، حساب الأجرة، وحلّ الشكاوى.

**لا نبيع بياناتك. لا نشاركها لأغراض تسويقية. لا نبني منها ملفات إعلانية.**

---

## ٣. مع من تُشارك

مع **الطرف الآخر في رحلتك فقط**، وبأقلّ قدر:

- يرى الراكب اسم الكابتن وسيارته وموقعه أثناء الرحلة.
- يرى الكابتن اسم الراكب ونقطة انطلاقه ووجهته.

**لا يرى أيٌّ منهما رقم هاتف الآخر.** هذا مفروض في الخادم ويحرسه اختبار آلي،
لا مجرد وعد.

**مزوّدو الخدمة** الذين يعالجون البيانات نيابةً عنا: Google (Firebase للمصادقة
والإشعارات، وخرائط Google لعرض الخريطة). لا يستعملونها لأغراضهم.

**السلطات:** نلتزم بطلب قانوني صحيح، ولا نسلّم شيئاً بدونه.

---

## ٤. كم نحتفظ بها

| البيانات | المدة |
|---|---|
| **سجل مواقع الكابتن** | **٩٠ يوماً**، ثم يُحذف آلياً |
| الموقع اللحظي أثناء الرحلة | في الذاكرة فقط، ينتهي بانتهاء اتصالك |
| رقمك واسمك | حتى تحذف حسابك |
| سجلات الرحلات والمعاملات المالية | تبقى — انظر أدناه |

---

## ٥. حذف حسابك

**من داخل التطبيق:** الملف الشخصي ← «حذف الحساب».

**يُحذف نهائياً:** رقم هاتفك · اسمك · هويتك في Firebase · رموز الإشعارات
· جلساتك · **كامل سجل مواقعك فوراً** (لا ينتظر الـ٩٠ يوماً).

**يبقى، بلا اسمك ولا رقمك:** سجلات رحلاتك ومعاملاتها المالية.

**ولماذا؟** بصراحة: القيود المالية في نظامنا **غير قابلة للحذف أو التعديل
بحكم التصميم** — فهي السجل المحاسبي الذي يثبت ما دُفع لمن. حذفها يعني القدرة
على تزوير سجل مالي، وهذا ما لا نسمح به لأنفسنا. لذلك نفصل اسمك عنها بدل أن
نحذفها، فتبقى الأرقام ولا تبقى هويتك فيها.

**لا يمكن الحذف أثناء رحلة جارية** — أنهِها أو ألغِها أولاً. وبعد الحذف يعود
رقمك متاحاً: إن عدت لاحقاً تحصل على **حساب جديد بلا أي تاريخ**.

---

## ٦. حقوقك

الوصول إلى بياناتك · تصحيح اسمك من التطبيق مباشرة · حذف حسابك من التطبيق
مباشرة · سحب صلاحية الموقع من إعدادات الهاتف في أي وقت (ولن يعمل وضع الكابتن
بدونها).

راسلنا على [البريد الإلكتروني] لأي طلب.

---

## ٧. الأطفال

الخدمة ليست موجّهة لمن هم دون ١٨ عاماً، ولا نجمع بياناتهم عن قصد.

---

## ٨. الأمان

كل الاتصالات مشفّرة بـ HTTPS/TLS — والتطبيق **يرفض العمل أصلاً** على إعداد
غير مشفّر. رموز الدخول تُخزَّن في المخزن الآمن للهاتف. الإحداثيات الدقيقة
لا تُكتب في سجلات النظام إطلاقاً.

لا يوجد نظام آمن مئة بالمئة، ولا ندّعي ذلك.

---

## ٩. التغييرات

سنحدّث هذه الصفحة عند تغيّر ما نجمعه، مع تغيير تاريخ «آخر تحديث» أعلاه.

---
---

# Privacy Policy — ALY

**Last updated: 5 September 2026**

ALY is a ride-hailing service operating in Baghdad, Iraq.

**Operator:** [legal name] · **Address:** [address] · **Privacy contact:**
[email]

## What we collect

**Phone number** — your login identity, stored as `+964…`. Verified through
Google Firebase Phone Auth, who act as a **processor** on our behalf, not as a
party we sell or share data with.

**Name** — optional; blank becomes "راكب". Shown only to the other party on a
ride.

**Location:**

| | Rider | Driver |
|---|---|---|
| While using the app | Yes | Yes |
| **In the background** | **Never** | **Yes, only while ONLINE** |

The rider app does not hold background-location permission at all. A driver's
position is sent continuously while they are ONLINE — otherwise the rider
watches a stationary car — through a foreground service with a permanent
notification, so it is never hidden. Going offline stops it.

**We do not collect:** payment instruments (fares are cash), contacts, photos,
files, messages, health data. No ads, no advertising identifiers.

## Why, and with whom

Operationally only: matching, live tracking, fares, disputes. **We do not sell
your data or share it for marketing.**

Shared with the other party on your ride, minimally. **Neither party ever sees
the other's phone number** — enforced server-side and covered by an automated
test. Processors: Google (Firebase, Maps).

## Retention

Driver location history: **90 days**, then deleted automatically. Live
positions: in memory, expiring with the session. Name and number: until you
delete your account.

## Deleting your account

In the app: Profile → Delete account.

**Erased:** phone number, name, Firebase identity, device tokens, sessions,
and your entire location history immediately.

**Retained without your name or number:** ride and financial records. Our
financial entries are **append-only by design** — they cannot be edited or
deleted, because that is what makes them a trustworthy record of what was paid
to whom. Being able to erase them would mean being able to falsify them. So we
detach your identity from them instead.

Not possible during a ride in progress. Afterwards your number is released: if
you return, you get a **new account with no history**.

## Your rights, children, security

Access, correct your name in-app, delete in-app, revoke location permission in
system settings at any time. Not directed at anyone under 18. All traffic is
HTTPS/TLS and the app refuses to run on an unencrypted configuration; tokens
live in the device's secure store; precise coordinates are never written to
system logs. No system is perfectly secure and we do not claim otherwise.

Contact: [email]
