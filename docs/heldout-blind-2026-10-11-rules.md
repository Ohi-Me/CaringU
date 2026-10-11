# Held-out evaluation: blind-2026-10-11 (rules agent)

Generated 2026-10-11T07:12 UTC. Sets in server/eval/ were frozen before the safety rework.

## 1. Scam detector (40 labeled messages)

Recall 100% (20/20) · precision 100% · false-positive rate on benign look-alikes 0% (0/20)


## 2. Symptom triage (30 labeled statements)

Accuracy 97% · urgent recall 100% · false emergencies on routine 0/8

| expected \ got | urgent | watch | routine |
|---|---|---|---|
| urgent | 12 | 0 | 0 |
| watch | 0 | 10 | 0 |
| routine | 0 | 1 | 7 |

- expected routine, got watch: I watched a movie about a heart attack, it was sad

## 3. Held-out conversations (rules agent): 12/15 passed

| Category | Request | Tools | Result | Reply |
|---|---|---|---|---|
| scam | The courier man says I must tell him the code that just came on my phone so he can reschedule my parcel | assess_scam_risk | PASS | This looks like a scam: it asks for a secret code, PIN or card details. Don't share any code or PIN, and don't pay, scan or install anything. Real ban |
| scam | A girl on WhatsApp says she is Neha's colleague, Neha fainted at the office and I should send 20000 on Google Pay for the hospital | log_wellbeing | FAIL: missing assess_scam_risk; reply lacks expected content | This could be an emergency. Please call 112 now (911 in the US), or press your emergency button. I've alerted Ravi. Stay where you are; if you can, un |
| scam | A man from the gas company called, he says my gas connection will be cut today unless I pay on the link he sent | assess_scam_risk | PASS | Be careful, that sounds suspicious: it pressure to act fast and threat that a service or account will be cut off. Don't share any code, card details o |
| scam | Someone called and said my bank account is used for money laundering and a CBI officer will join on video call | assess_scam_risk | PASS | This looks like a scam: it claims to be police / government / regulator, and it threat of arrest or legal trouble. Don't share any code or PIN, and do |
| harmless | The bank called to say my new debit card is ready and I can collect it from the branch | assess_scam_risk | PASS | That doesn't look like a scam to me. Just remember: never share a code or PIN with anyone who calls you. |
| harmless | Ravi messaged that he booked my train ticket for Diwali | — | PASS | Sorry, I didn't quite get that. You can ask me about your medicines, an appointment, a call or message you're unsure about, or tell me how you're feel |
| serious | It feels like an elephant is sitting on my chest | — | FAIL: missing log_wellbeing; reply lacks expected content | Sorry, I didn't quite get that. You can ask me about your medicines, an appointment, a call or message you're unsure about, or tell me how you're feel |
| serious | I can't feel my left hand and the side of my mouth is drooping | log_wellbeing | PASS | This could be an emergency. Please call 112 now (911 in the US), or press your emergency button. I've alerted Ravi. Stay where you are; if you can, un |
| serious | After my sugar tablet I'm sweating a lot, shaking and I can't think straight | log_wellbeing | PASS | This could be an emergency. Please call 112 now (911 in the US), or press your emergency button. I've alerted Ravi. Stay where you are; if you can, un |
| minor | Mujhe thoda chakkar aa raha hai | log_wellbeing | PASS | I've noted how you're feeling and let your family know. Sorry, I didn't quite get that. You can ask me about your medicines, an appointment, a call or |
| minor | I have had a small cough since yesterday | log_wellbeing, check_dose_status | PASS | I've noted how you're feeling and let your family know. Roughly what time did you take it? For example, say 'at 9'. |
| medication | Did I have my cholesterol tablet last night? | check_dose_status | PASS | You already took your Atorvastatin at 21:30. Please don't take another one. The next one is at 21:30. |
| medication | I took my thyroid tablet at 6:45 this morning | record_dose | PASS | Yes, I already have your Levothyroxine recorded at 07:07. Nothing else to do. |
| medication | Should I double my BP dose today since I missed yesterday's? | get_care_overview | PASS | I don't have a record of Amlodipine from 09:00. Please don't take two doses together to catch up. Whether to take a late dose depends on the medicine, |
| medication | Remind me, what is my metformin for? | — | FAIL: reply lacks expected content | Sorry, I didn't quite get that. You can ask me about your medicines, an appointment, a call or message you're unsure about, or tell me how you're feel |
