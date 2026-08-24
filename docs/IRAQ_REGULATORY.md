# IRAQ_REGULATORY.md

Regulatory research for operating a ride-hailing platform in Baghdad.
Compiled 2026-08-24.

> **This is not legal advice, and it is not sufficient to launch on.** Every
> line below is either sourced or explicitly marked as unverified. An Iraqi
> lawyer and the relevant ministries are the only authorities on any of it.
> Nothing here was inferred from a forum post or a vendor's marketing page and
> then presented as fact.

---

## What the search actually returned

Honest first finding: **authoritative primary sources are scarce online.** Most
results for "ride-hailing licensing Iraq" are marketing pages from app-
development vendors selling taxi-app templates. Those are not regulators and
their claims are not evidence.

What follows separates the two.

## 1. Company and operating registration — **CONFIRMED IN OUTLINE, DETAIL UNVERIFIED**

Ride-hailing operators in Iraq are reported to require official registration
with the relevant government departments, including establishment and
licensing certificates and official approvals.

**Status: directionally confirmed, procedurally unverified.** No source found
online names the specific department, the fee schedule, or the processing time.

**Action:** contact the Ministry of Transport and the Baghdad governorate
directly. Do not rely on any vendor blog for this.

## 2. Precedent — **CONFIRMED**

Careem and Uber operate in Baghdad and Erbil. Baly operates at national scale.

This matters more than it looks: **the activity is evidently permitted**, so
the question is compliance with an existing path, not whether one exists.

## 3. Driver documentation — **REPORTED, TREAT AS A MINIMUM**

Commonly cited: national ID, Iraqi driving licence, vehicle registration,
vehicle inspection.

**Relevance to this codebase:** `CLAUDE.md` §2 puts driver KYC and document
upload OUT of v1 scope, and `BLOCKER-2` records that as an open scope
conflict. If the regulator requires verified documents, that conflict stops
being a preference and becomes a launch blocker. **This is the single most
likely place where regulation forces a scope change.**

## 4. Data protection — **CONFIRMED, AND MORE FAVOURABLE THAN EXPECTED**

Iraq has **no comprehensive GDPR-equivalent data protection statute in force**.
A Personal Data Protection Law has been in drafting and consultation since
2021, is expected to be finalised around the end of 2026, and would establish
an Iraqi National Data Protection Authority and consent requirements.

In the meantime privacy rests on the 2005 Constitution — Article 17 (personal
privacy) and Article 40 (confidentiality of electronic communications).

**What this means for the platform:**

- There is no local statutory bar to launching with the current data handling.
- The law is expected imminently. Building to it now is far cheaper than
  retrofitting. The repository already does most of what such a law asks:
  PII redaction in logs, coordinates coarsened, phone numbers never logged,
  an append-only audit trail, and revocable sessions.
- **Google Play's own Data Safety requirements apply regardless of Iraqi law**
  and are enforced at review. That is the nearer constraint.

## 5. Electronic commerce — **CONFIRMED**

Iraq enacted **Electronic Trade Regulation No. 4 of 2025** in March 2025,
described as establishing legal infrastructure for online commerce.

**Not yet read in full.** Whether it imposes obligations on a cash-settled ride
platform is unknown and needs a lawyer's reading, not mine.

## 6. Insurance, municipal permits, fare regulation — **NOT FOUND**

No reliable online source was found for passenger-carriage insurance
requirements, Baghdad municipal permits for commercial passenger transport, or
whether fares are regulated.

**Absence of evidence is not evidence of absence.** These are exactly the
requirements that tend to exist locally and be invisible online.

---

## What this changes in the code — nothing yet, deliberately

No code was altered on the strength of this research. Two things are worth
recording:

1. **BLOCKER-2 gains weight.** Driver KYC is deferred by owner decision. If
   documents are mandatory, that decision has an external deadline.
2. **The forthcoming PDPL argues for keeping the existing privacy discipline**
   rather than relaxing it. The account-deletion and data-retention work that
   `docs/PRODUCTION_READINESS.md` lists as missing moves up in priority.

## The only honest next step

Three questions, to a lawyer and to the Ministry of Transport:

1. What licence does an app-based passenger transport intermediary need, and
   does it differ from a taxi operator's?
2. Are drivers required to hold verified documents that the platform must
   check and retain?
3. Does Electronic Trade Regulation No. 4 of 2025 apply to a cash-settled ride
   platform?

Answers to those three determine whether v1 scope is legal as designed.

---

## Sources

- [Iraq's Right to Access Information Law: Outlook for 2026 — Al Tamimi & Company](https://www.tamimi.com/our-knowledge/publications/eyes-on-2026/articles/iraqs-right-to-access-information-law-outlook-for-2026/)
- [Iraq — DataGuidance](https://www.dataguidance.com/jurisdictions/iraq)
- [Iraqi Personal Data Protection Law Guide — Privacy Laws Hub](https://globalprivacylaws.com/laws/pdpl-iraq/)
- [Corporate M&A 2026, Iraq — Chambers and Partners](https://practiceguides.chambers.com/practice-guides/corporate-ma-2026/iraq/trends-and-developments)
- [Iraq AI Regulation Overview — Regulations.ai](https://regulations.ai/regulations/iraq-summary)
- [How to Start a Taxi Business in Iraq — Appicial](https://www.appicial.com/blog/how-to-start-a-taxi-business-in-iraq-a-complete-guide.html) *(vendor marketing — used only for the driver-document list, which is corroborative at best)*
- [Launch a ride-hailing service in Iraq — Waslni](https://waslni.app/launch-ride-hailing-iraq) *(vendor marketing — same caveat)*
