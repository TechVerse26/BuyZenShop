# Shop Verse (v2)

স্ট্যাটিক (build-step ছাড়া) ই-কমার্স প্ল্যাটফর্ম — **স্টোরফ্রন্ট + অ্যাডমিন প্যানেল**। HTML/CSS/vanilla ES modules + Firebase (Auth, Firestore, Storage), হোস্টিং Vercel।
কোনো নিজস্ব সার্ভার নেই; **Firestore Security Rules-ই বিশ্বাসযোগ্য স্তর** (দাম, স্টক, কুপন, শিপিং ফি সবসময় rules দিয়ে নতুন করে যাচাই হয়)।

> **এই রিলিজের অবস্থা:** স্টোরফ্রন্ট সম্পূর্ণ; অ্যাডমিনের মূল মডিউল (ড্যাশবোর্ড, অর্ডার, প্রোডাক্ট, ইনভেন্টরি, স্টাফ ও রোল, সেটআপ ও মাইগ্রেশন, সেটিংস) তৈরি ও পরীক্ষিত।
> কিছু অ্যাডমিন মডিউল **এখনো তৈরি হয়নি** (ক্যাটাগরি/ব্র্যান্ড, শিপিং জোন, কুপন, কাস্টমার, রিভিউ, সাপোর্ট, হোম/পেজ কনটেন্ট, রিপোর্ট, অডিট লগ) — মেনুতে সেগুলো দেখানো হয় না।
> সম্পূর্ণ তালিকা, টেস্টের ফলাফল ও সীমাবদ্ধতা: **[docs/STATUS.md](docs/STATUS.md)**।

## কী কী আছে

**স্টোরফ্রন্ট** — হোম (সেকশনভিত্তিক), শপ/ফিল্টার/সার্চ, ক্যাটাগরি ও ব্র্যান্ড পেজ, প্রোডাক্ট ডিটেইল (গ্যালারি, ভ্যারিয়েন্ট, রিভিউ), কার্ট, চেকআউট (COD, bKash/Nagad ম্যানুয়াল), অর্ডার ট্র্যাকিং, অ্যাকাউন্ট (অ্যাড্রেস, উইশলিস্ট, নোটিফিকেশন, রিটার্ন), কন্টাক্ট, CMS পেজ, বাংলা/ইংরেজি, লাইট/ডার্ক, PWA (অফলাইন পেজ সহ)।

**অ্যাডমিন** (`/admin/`) — রোলভিত্তিক প্যানেল (Super Admin, Store Admin, Product Manager, Order Manager, Inventory Manager, Customer Support, Reporting):
ড্যাশবোর্ড · অর্ডার (স্ট্যাটাস, পেমেন্ট যাচাই, রিফান্ড, রিটার্ন, ইনভয়েস) · প্রোডাক্ট (একাধিক ছবি, ভ্যারিয়েন্ট, SEO, ড্রাফট) · ইনভেন্টরি (মুভমেন্ট, CSV ইম্পোর্ট/এক্সপোর্ট) · স্টাফ ও রোল · সেটিংস · সেটআপ চেকলিস্ট ও পুরনো ডেটার মাইগ্রেশন।

## লোকালে চালানো

```bash
node tools/dev-server.mjs          # বা: npm run dev   → http://localhost:5173  (/admin/ → অ্যাডমিন)
```
লোকাল সার্ভার আসল Firebase প্রজেক্টের (`js/config/firebase-config.js`) সাথে কথা বলে — তাই ইন্টারনেট লাগবে।

## প্রথমবার চালু করার ধাপ (সংক্ষেপে — বিস্তারিত: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md))

1. **Firebase Auth** চালু করুন (Email/Password, Google; ফোন OTP চাইলে Phone) এবং Vercel ডোমেইন "Authorized domains"-এ যোগ করুন।
2. **Rules ডিপ্লয়:** `firebase deploy --only firestore:rules,firestore:indexes,storage`
   ⚠️ নতুন rules ডিপ্লয় করলে **পুরনো সাইটের লেখার অংশ (অ্যাডমিন/অর্ডার) আর কাজ করবে না** — ডিপ্লয়ের ঠিক পরেই ধাপ ৩–৪ সেরে ফেলুন।
3. **প্রথম Super Admin:** `/admin/`-এ সাইন-ইন করুন → "অ্যাক্সেস নেই" স্ক্রিনে আপনার **UID** দেখাবে → Firebase Console → Firestore → `staff` কালেকশন → ডকুমেন্ট ID = আপনার UID, ফিল্ড `role: "super_admin"`, `active: true` (boolean), `email`, `name`।
4. **মাইগ্রেশন:** অ্যাডমিন → *সেটআপ ও মাইগ্রেশন* → চেকলিস্ট দেখুন → "প্রিভিউ" → "চালান" (পুরনো প্রোডাক্টকে নতুন কাঠামোতে আনে; নন-ডেস্ট্রাক্টিভ, আবার চালালে ক্ষতি নেই)।
5. **সেটিংস:** স্টোরের নাম, যোগাযোগ, **bKash/Nagad নম্বর** (ডিফল্ট পুরনো সাইট থেকে নেওয়া — Nagad নম্বর যাচাই করুন), ইনভয়েস ঠিকানা।
6. Vercel-এ ডিপ্লয় (Framework: Other, Build Command ও Output Directory ফাঁকা/`.`)।

## টেস্ট

```bash
npm test               # ইউনিট + Firestore rules (Node ≥ 20, কোনো ডিপেন্ডেন্সি লাগে না)
npm run check          # সিনট্যাক্স/নিরাপত্তা লিন্ট + ইমপোর্ট যাচাই
# ব্রাউজার টেস্ট (Chromium লাগে):  npm i --no-save playwright && npx playwright install chromium
npm run test:e2e       # সব রুটের স্মোক টেস্ট (ফোন + ডেস্কটপ)
npm run test:flows     # ক্লিক-থ্রু সিনারিও (ফোন + ডেস্কটপ)
```
ব্রাউজার টেস্ট একটি **mock Firebase** চালায় যা আসল `firestore.rules` ইন্টারপ্রেট করে — আসল Firebase বা Emulator-এ চালানো হয়নি (বিস্তারিত: STATUS.md)।

## ফোল্ডার

```
index.html, admin/index.html   শেল          css/  tokens, base, components, layout, store, admin, pages/
js/core      ব্রাউজার হেল্পার (dom, ui, i18n, router, firebase …)      js/shared  খাঁটি লজিক (দাম, অর্ডার ফ্লো, মাইগ্রেশন … — Node-এ টেস্টযোগ্য)
js/data      Firestore অ্যাক্সেস                                          js/store, js/admin   পেজ ও কম্পোনেন্ট
firestore.rules, storage.rules, vercel.json, sw.js, manifest.webmanifest
tests/ (unit, rules, e2e)   tools/ (লিন্ট, ডেভ সার্ভার, ইনডেক্স জেনারেটর)   docs/
```

## নিরাপত্তা ও পেমেন্ট — মূল নীতি
- দাম/ডিসকাউন্ট/শিপিং/স্টক ব্রাউজারের কথায় বিশ্বাস করা হয় না; অর্ডার কেবল একটি অ্যাটমিক ব্যাচে তৈরি হয় যা rules নতুন করে হিসাব করে মিলিয়ে দেখে।
- bKash/Nagad: গ্রাহকের দেওয়া TrxID কেবল একটি **দাবি** — স্টাফ যাচাই না করা পর্যন্ত অর্ডার "পেমেন্ট যাচাই বাকি"; কোনো আসল পেমেন্ট গেটওয়ে যুক্ত নেই।
- কোনো সিক্রেট কোডে নেই (`firebase-config.js` প্রকাশ্য আইডেন্টিফায়ার; সুরক্ষা দেয় rules + Auth সেটিংস)। API key শুধু আপনার ডোমেইনে সীমিত করুন।
- স্টাফের প্রতিটি পরিবর্তন `auditLogs`-এ লেখা হয় (অ্যাডমিন অ্যাপ লেখে; rules লগ বাধ্যতামূলক করে না)।

## ডকুমেন্ট
[STATUS](docs/STATUS.md) (অবস্থা, QA, সীমাবদ্ধতা) · [DEPLOYMENT](docs/DEPLOYMENT.md) · [CONVENTIONS](docs/CONVENTIONS.md) (ইঞ্জিনিয়ারিং নিয়ম) · [DATA_MODEL](docs/DATA_MODEL.md) (Firestore মডেল ও অ্যাক্সেস) · [API_INDEX](docs/API_INDEX.md) · [CSS_INDEX](docs/CSS_INDEX.md)
