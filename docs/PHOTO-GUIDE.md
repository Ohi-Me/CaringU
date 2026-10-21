# Photo guide: real photos for the CaringU camera checks

## 1. Scam Lens (start here: about 15 minutes, 24 photos)

This set gives the OpenCV entry real-camera numbers for Scam Lens.

1. Open the three sample codes on your laptop screen, one at a time:
   `web/public/samples/prize-flyer.jpg`, `kyc-message.jpg` and `pharmacy-bill.jpg`.
   You can also print them; paper and screen both count.
2. With your phone camera, take **8 photos of each**, changing one thing each time:
   close / arm's length / across the room, straight / tilted, room light / dim light, and one with glare from a lamp or window.
3. Name them by which sample is in the photo, then a number:
   `prize_1.jpg` … `prize_8.jpg`, `kyc_1.jpg` … `kyc_8.jpg`, `pharmacy_1.jpg` … `pharmacy_8.jpg`.
   Optional: 2–3 photos with **no code** in them, named `nocode_1.jpg` etc. (checks that nothing is "read" by mistake).
4. Put them in `vision/data/lens_real/` and tell me. The evaluation labels them from the names automatically.

Don't photograph your own UPI or bank QR codes. They contain your personal payment ID.

## 2. Medicine strips (strip check)

These photos are the evaluation dataset for the strip check. They're what proves the vision works on real strips, so follow the naming carefully. About **45–60 photos** total. The phone camera is fine.

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
- Use other people's photos from the internet (we need photos we have the rights to).

## Where to put them
Copy them to **`vision/data/raw/`** in the project folder (WhatsApp/Drive to yourself, then save there), then tell me.
I'll check every label by looking at each photo, and ask you about any I'm unsure of.
