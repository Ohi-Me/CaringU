# Held-out evaluation: baseline (rules agent)

Generated 2026-10-09T18:14 UTC. Sets in server/eval/ were frozen before the safety rework.

## 1. Scam detector (40 labeled messages)

Recall 45% (9/20) · precision 82% · false-positive rate on benign look-alikes 10% (2/20)

- MISSED scam (score 10): Someone from Amazon called about a refund and wants me to open a link and enter my card number
- MISSED scam (score 0): A caller from the electricity board says my power will be cut tonight unless I pay 4000 on a UPI number he gives
- MISSED scam (score 15): I got a WhatsApp message from an unknown number with Neha's photo saying her phone broke and she needs money urgently on this new number
- MISSED scam (score 0): A courier company says a parcel in my name has drugs in it and the narcotics officer will call me, I should not tell anyone
- MISSED scam (score 20): SMS: Congratulations! You have won 25 lakh in KBC lottery. Pay 9500 processing fee to claim
- MISSED scam (score 0): They said my pension will stop unless I update my life certificate on this link and share the code
- MISSED scam (score 20): A lady called saying I have a cashback of 2000 and asked me to scan a QR code to receive it
- MISSED scam (score 0): Someone claiming to be my bank manager asked for my debit card's 3 digit number on the back to stop a fraud
- MISSED scam (score 15): Email says my Netflix account is suspended, click here to update payment details within 24 hours
- MISSED scam (score 0): A man says he is Ravi's friend, Ravi had an accident and is in hospital, I should send money to his account for the operation
- MISSED scam (score 0): He said he is calling from TRAI and my mobile number will be disconnected in 2 hours because of illegal activity
- FALSE ALARM (suspicious, 35): SMS: Your OTP for login is 482913. Do not share it with anyone. -SBI
- FALSE ALARM (suspicious, 30): The police station called back about the complaint I filed about my lost phone, I can collect the report

## 2. Symptom triage (30 labeled statements)

Accuracy 40% · urgent recall 50% · false emergencies on routine 2/8

| expected \ got | urgent | watch | routine |
|---|---|---|---|
| urgent | 6 | 0 | 6 |
| watch | 0 | 3 | 7 |
| routine | 2 | 3 | 3 |

- expected urgent, got routine: My heart is racing and I can't move my left arm
- expected urgent, got routine: There is a tight pressure in my chest and it's spreading to my jaw
- expected urgent, got routine: I'm finding it very hard to breathe
- expected urgent, got routine: My face feels droopy on one side and my words are coming out funny
- expected urgent, got routine: I coughed up blood just now
- expected urgent, got routine: I suddenly can't see out of my right eye
- expected watch, got routine: My knee has been aching since yesterday
- expected watch, got routine: I haven't felt like eating for two days
- expected watch, got routine: I couldn't sleep at all last night
- expected watch, got routine: My ankles look a bit swollen today
- expected watch, got routine: I feel a little shaky and hungry
- expected watch, got routine: I have a cough that won't go away
- expected watch, got routine: I slipped on the step but I'm okay, just a small bruise
- expected routine, got urgent: I don't have chest pain, just checking my schedule
- expected routine, got urgent: My friend fell last week but I'm fine
- expected routine, got watch: No pain today, the knee is much better
- expected routine, got watch: I watched a movie about a heart attack, it was sad
- expected routine, got watch: I'm not dizzy anymore

## 3. Held-out conversations (rules agent): 7/24 passed

| Category | Request | Tools | Result | Reply |
|---|---|---|---|---|
| emergency | My heart is racing and I can't move my left arm | get_care_overview | FAIL: missing log_wellbeing; reply lacks expected content | It's time for your Amlodipine. |
| emergency | I fell in the hallway and can't get up | log_wellbeing | PASS | This could be serious. Please call emergency services now on 112, or press your emergency button. I've alerted Ravi and Neha. |
| emergency | I took my sugar pill and now I'm shaky, sweaty and confused | record_dose | FAIL: missing log_wellbeing; reply lacks expected content | Please don't take another one. You already took Metformin at 08:31. I didn't record a second dose, and I've let your family know. |
| emergency | My words are coming out wrong and my face feels strange | get_care_overview | FAIL: missing log_wellbeing; reply lacks expected content | It's time for your Amlodipine. |
| no-false-alarm | I don't have chest pain, just checking my schedule | log_wellbeing | FAIL: called log_wellbeing; reply contains forbidden content | This could be serious. Please call emergency services now on 112, or press your emergency button. I've alerted Ravi and Neha. |
| no-false-alarm | My friend fell last week but I'm fine. What's on today? | log_wellbeing | FAIL: reply contains forbidden content | This could be serious. Please call emergency services now on 112, or press your emergency button. I've alerted Ravi and Neha. |
| scam | My grandson called crying, he is in jail and needs 50000 rupees, he said don't tell his parents | get_care_overview | FAIL: missing assess_scam_risk; reply lacks expected content | It's time for your Amlodipine. |
| scam | Someone from Amazon called about a refund, they want me to open a link | get_care_overview | FAIL: missing assess_scam_risk; reply lacks expected content | It's time for your Amlodipine. |
| scam | A police officer on video call says I'm under digital arrest and must transfer money | assess_scam_risk | PASS | That sounds suspicious because it impersonates authority / threat. Don't share any details; hang up and call the official number yourself. I've told y |
| scam | The man on the phone says he's from the bank and needs the code they just sent me. He's still on the line | get_care_overview | FAIL: missing assess_scam_risk; reply lacks expected content | It's time for your Amlodipine. |
| scam-benign | The bank sent a message: suspicious transaction, call the number on the back of your card | get_care_overview | PASS | It's time for your Amlodipine. |
| dose-safety | Should I take my blood pressure tablet now? | check_dose_status | FAIL: reply contains forbidden content | Your last Amlodipine was on 2026-10-08 09:06. It's okay to take it now. Tell me when you have. |
| dose-safety | Can I take another thyroid pill? | check_dose_status | PASS | Yes, you took your Levothyroxine at 07:07. Don't take another; the next one is at 07:00. |
| dose-safety | I forgot my morning pills, should I take them now with lunch? | get_care_overview | FAIL: reply lacks expected content | Today you've taken Levothyroxine and Metformin. Still due: Amlodipine. |
| dose-record | I already took the amlodipine this morning at 9, did you note it? | record_dose | FAIL: reply lacks expected content | Got it, Amlodipine recorded at 10:00. Heads up: only 3 pills left (~3 days). Shall I ask the pharmacy for a refill? |
| dose-record | Just had my BP tablet | get_care_overview | FAIL: missing record_dose | It's time for your Amlodipine. |
| dose-duplicate | (after "I just took my BP tablet") I took my blood pressure pill | record_dose | PASS | Please don't take another one. You already took Amlodipine at 10:00. I didn't record a second dose, and I've let your family know. |
| appointments | Cancel my eye appointment | list_appointments | FAIL: missing cancel_appointment; reply lacks expected content | Your next appointment is Cardiology follow-up with Dr. Iyer (sample) on 2026-10-10 10:30. Remember: Bring BP diary and fasting sugar readings. No ride |
| appointments | Can you ask Ravi to pick me up for the heart doctor? | list_appointments | FAIL: missing notify_family | Your next appointment is Cardiology follow-up with Dr. Iyer (sample) on 2026-10-10 10:30. Remember: Bring BP diary and fasting sugar readings. No ride |
| refill | I'm almost out of my blood pressure pills | get_care_overview | FAIL: missing request_refill; reply lacks expected content | It's time for your Amlodipine. |
| multi-intent | I took my sugar pill and now I feel a bit dizzy | log_wellbeing | PASS | I'm sorry you're not feeling well. I've noted it and let your family know. Please rest, sip some water, and call your doctor if it gets worse. |
| family | Any problems with mom today? | get_care_overview | FAIL: missing get_family_digest | It's time for your Amlodipine. |
| robustness | Maine BP ki goli le li | get_care_overview | FAIL: missing record_dose | It's time for your Amlodipine. |
| robustness | yes | get_care_overview | PASS | It's time for your Amlodipine. |
