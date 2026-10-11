# Photo guide: medicine strips for the CareCircle strip check

These photos are the evaluation dataset for the OpenCV competition. They're what proves the vision works on real strips, so follow the naming carefully. About **45–60 photos** total. The phone camera is fine.

## What to photograph

Use **5–8 different strips**. Include a full one, some partly used ones, and one that's nearly empty. Different shapes and colours help (round and oval pills, clear and silver blisters).

### A. One *reference* photo per strip (the "registration" photo)
- Strip **flat on a plain table**, photo taken from directly **above**, good daylight, whole strip visible, **bump side up** (the side where you see the pills).
- Name: `ref_<medicine>_<left>of<total>.jpg`, for example `ref_paracetamol_6of10.jpg` (6 pills left out of 10 cavities).
- Use one short name per strip with letters, numbers or `-` only (e.g. `paracetamol`, `vitd3`, `pan-40`), and the **same name** in its test photos.

### B. 6–8 *test* photos per strip, each one a little different
Vary one or two things each time:
- **angle:** tilted up to about 30°, or rotated
- **background:** cloth, newspaper, bedsheet, hand
- **light:** window, ceiling light, dim evening light, some glare
- **distance:** close, or the strip small in the frame
- **a finger partly covering it** (1 photo only)
- at least **one photo of the foil side** (the back)

Name: `<medicine>_<left>of<total>_<n>.jpg`, where `left` is how many pills are still in the strip and `total` is how many cavities it has.
Example: `paracetamol_6of10_3.jpg` means 6 pills left out of 10 cavities, 3rd photo. Foil-side photos: add `_back`, for example `paracetamol_6of10_7_back.jpg`.

## Please don't
- Pop pills just for photos. Use the strips as they are.
- Include anything personal: no prescriptions with names, bills or addresses in the frame.
- Use other people's photos from the internet (they'd break the competition's data-rights rule).

## Where to put them
Copy them to **`D:\Hackathon\A_Dev_DevPost\vision\data\raw\`** on the laptop (WhatsApp/Drive to yourself, then save there), then tell me.
I'll check every label by looking at each photo, and ask you about any I'm unsure of.
