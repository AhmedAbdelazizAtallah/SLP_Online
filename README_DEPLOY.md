# 🌐 دليل نشر المشروع أونلاين — مجاني 100%

النسخة دي جاهزة للنشر على **Render.com** (فري تير للأبد، بدون دومain مدفوع).
هتاخد رابط زي: `https://sign-language-platform.onrender.com`

---

## ✅ إيه اللي اتعمل في النسخة دي (مقارنة بـ D:\SLP)؟

| التعديل | السبب |
|---|---|
| `Server.py` يقرأ `PORT` من البيئة | سحابة النشر بتحدد البورت بنفسها |
| تشغيل موديلات TFLite عبر `tensorflow-cpu` (لينكس وويندوز) | الموديلات بتستخدم Flex ops — `tflite-runtime` الصغير مش قادر يحملها |
| عنوان الـ API بقى تلقائي (same-origin) | الصفحة تشتغل على أي دومain بدون تعديل يدوي |
| إعدادات TURN بتتيجي من السيرفر (`/api/ice-servers`) | مفيش أسرار في الكود — بتتحط كمتغيرات بيئة وتتغير بدون تعديل الملفات |
| حمايات السيرفر: حد أقصى لحجم `/predict` وسعة الغرف وحجم رسائل الـ WS | يمنع التعليق أو استنزاف الموارد |
| `render.yaml` + `Dockerfile` | ملفات النشر الجاهزة |

الموديلات هي هي: `arsl_model.tflite` و `asl_model.tflite` ✓

---

## 🔐 متغيرات البيئة الاختيارية (Render Dashboard → Environment)

| المتغير | الوظيفة |
|---|---|
| `TURN_URL` | عناوين TURN مفصولة بفواصل (مثلًا حساب مجاني على metered.ca) |
| `TURN_USERNAME` / `TURN_CREDENTIAL` | بيانات دخول الـ TURN |
| `MAX_ROOM_SIZE` | الحد الأقصى للمشاركين في الغرفة (الافتراضي 8) |

لو سيبتها فاضية: المكالمات هتشتغل على نفس الشبكة بالـ STUN بس، وعلى شبكات مختلفة ممكن الفيديو ميوصّلش.
مهم: **أي بيانات TURN كانت متحططة في الكود القديم اعتبرها مسرّبة** — غيّرها (rotate) من حساب metered.ca وحط الجديدة في متغيرات البيئة فقط.

---

## 🚀 خطوات النشر (10 دقايق مرة واحدة)

### 1) ارفع المشروع على GitHub
1. اعمل حساب مجاني على [github.com](https://github.com) لو معندكش
2. اعمل Repository جديد اسمه مثلًا `sign-language-platform` وخلّيه **Private** أو Public
3. ارفع **محتويات المجلد `D:\SLP_Online`** كله (ما عدا venv لو موجودة — ملف `.gitignore` بيمنعها)

أسهل طريقة بدون أوامر: نزّل GitHub Desktop → File → Add local repository → اختار `D:\SLP_Online` → Commit → Publish

### 2) انشر على Render
1. اعمل حساب مجاني على [render.com](https://render.com) (يمكن تسجيل دخول بحساب جوجل/GitHub)
2. من الـ Dashboard اضغط **New +** → اختار **Blueprint**
3. اختار مستودع GitHub اللي رفعته
4. Render هيقرأ ملف `render.yaml` تلقائيًا ويظبط كل حاجة
5. اضغط **Apply** واستنى 5-10 دقايق
6. هيديك رابط زي: `https://sign-language-platform-xxxx.onrender.com`

### 3) افتح الرابط من أي مكان في العالم 🎉
- الكاميرا والمايك هيشتغلوا لأن الموقع HTTPS
- SIGN ROOMS هتشتغل بين موبايل ولابتوب على شبكات مختلفة
- ابعت حد كود الغرفة أو لينك INVITE وهو يفتح على طول

---

## ⚠️ حاجات مهمة في الفري تير

1. **السيرفر بينام** بعد 15 دقيقة بدون زوار → أول فتح بعدها بياخد 30-60 ثانية يصحى
   - **الحل المجاني:** اعمل حساب على [cron-job.org](https://cron-job.org) وخليه يزور `/health` كل 10 دقايق → السيرفر يفضل صاحي 24 ساعة
2. أول deploy ممكن ياخد وقت أطول (تحميل المكتبات)
3. لو Render سألك عن Card للتحقق البشري في التسجيل ده إجراء عادي

---

## 🔁 تحديث الموقع بعد أول نشر
أي تعديل تعمله في `app.html` أو `Server.py` وترفعه على GitHub → Render يعيد النشر **تلقائيًا**.

---

## 🖥️ التشغيل المحلي (زي ما هو)
```
cd D:\SLP_Online
set PORT=8000
python Server.py        (استخدم بيئة فيها TensorFlow)
```
أو استخدم نفس venv المشروع الأصلي:
```
D:\SLP\venv\Scripts\python.exe Server.py
```

---

## ❓ حل مشاكل شائعة
| المشكلة | الحل |
|---|---|
| Deploy فشل على tflite-runtime | اتأكد إن PYTHON_VERSION = 3.11.9 (موجود في render.yaml) |
| أول فتح بطيء | ده طبيعي (تنام السيرفر) — فعّل cron-job.org |
| الكاميرا مش بتطلب صلاحية | لازم الموقع يكون https:// وليس http:// |
| صوت الزائر مش بيجي | اضغط 🔇 SOUND ON في غرفة السيجن رومز |
| الفيديو بين شخصين على شبكات مختلفة مش بيتوصل (Waiting للأبد) | ضيف TURN مجاني: حساب على metered.ca → حط `TURN_URL` / `TURN_USERNAME` / `TURN_CREDENTIAL` في متغيرات البيئة على Render (أو مؤقتًا من الموقع: SIGN ROOMS ← Advanced ← TURN relay) |
| المايك مكتوب عليه unsupported | متصفحك مش بيدعم Speech Recognition — استخدم Chrome أو Edge |

---

## 🚀 نشر SLP_Next في 5 دقائق (Render Blueprint)

> الحزمة المجمعة `app.compiled.js` ومكتبات `vendor/` مرفوعة مع المستودع — **Render لا يحتاج أي خطوة build إضافية**.

1. **ارفع المستودع** (تم تجهيزه):
   ```
   cd D:\SLP_Next
   git remote add origin https://github.com/<حسابك>/slp-next.git
   git push -u origin master
   ```
2. **render.com** → New + → **Blueprint** → اختر المستودع → **Apply**
   (يقرأ render.yaml تلقائياً: Python 3.11.9 + فرانكفورت + فري تير + /health)
3. المتغيرات اللي هيطلبها **كلها اختيارية**. أضف `TURN_URL/USERNAME/CREDENTIAL` من حساب TURN خاص بك لتعمل المكالمات خلف الشبكات المقيدة؛ لا توجد بيانات دخول مخزنة في الكود. ويمكنك أيضًا ضبط `MAX_ROOM_SIZE` و`ERR_RATE_LIMIT`.
4. استنى 5-10 دقائق أول مرة (تحميل TensorFlow-CPU) → الرابط: `https://sign-language-platform-next.onrender.com`
5. فعّل البقاء المستيقظ: cron-job.org يزور `/health` كل 10 دقائق

### بعد أي تعديل مستقبلي
```
عدّلت كود React في app.html؟ → powershell -File build.ps1   (يعيد توليد الحزمة ويختم build-id)
git add -A ; git commit -m "..." ; git push   ← Render يعيد النشر تلقائياً
```

### فروق SLP_Next عن SLP_Online
| | SLP_Online | SLP_Next |
|---|---|---|
| المنفذ المحلي الافتراضي | 8000 | **8010** (عزل كامل بين المشروعين) |
| مكتبات الواجهة | CDN (unpkg) | **Self-hosted** من vendor/ |
| PWA | ✗ | ✓ (تثبيت + أوفلاين جزئي) |
| ترجمة فيديو مرفوع | ✗ | ✓ |
| PIN الغرف / REC / Reconnect / ALPHABET / MY WEAK | ✗ | ✓ |
