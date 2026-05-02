# ICC Color Management Test Images

**Example free to use AI Generated reference images for visual and colorimetric evaluation of ICC profiles, color management modules (CMMs), and gamut mapping algorithms.**

These images were created as examples for open-source color management projects. They provide test cases for:

- Contrast and black point rendering
- Gamut coverage and out-of-gamut handling
- Skin tone reproduction (memory colors)
- Hue/saturation accuracy across a wide color range
- Detail preservation in highlights and shadows

---

## Image Set

### 01. High-Contrast B&W Elderly Portrait
**File:** `face.png`

**Purpose:**
- Extreme contrast and dynamic range testing
- Black point and shadow detail evaluation
- Texture and micro-contrast rendering (wrinkles, pores, skin texture)
- Monochrome workflow validation
- Edge definition and sharpening artifact detection

**Key Features:**
- Deep, pure blacks with subtle shadow detail
- Bright specular highlights on skin
- Extremely fine skin texture and wrinkles
- High-frequency detail throughout

**Recommended Tests:**
- Convert to various output profiles (e.g., printer, display)
- Test perceptual vs. relative colorimetric rendering intents
- Evaluate black generation (GCR/UCR) in CMYK conversions
- Check for posterization in gradients

---

### 02. Vibrant Colorful Fruit Still Life
**File:** `fruit.png`

**Purpose:**
- Wide-gamut color reproduction testing
- Saturation and chroma accuracy
- Hue separation and color differentiation
- Specular highlight and reflection handling
- Memory color validation (apples, bananas, strawberries, etc.)

**Key Features:**
- Highly saturated primary and secondary colors (reds, yellows, oranges, greens, purples)
- Mix of matte and glossy surfaces
- Strong color contrast between adjacent objects
- Natural color gradients in fruit surfaces
- Clean black background for easy masking

**Recommended Tests:**
- Soft-proofing to smaller gamuts (sRGB → CMYK, Rec.709, etc.)
- Gamut mapping algorithm comparison (clipping vs. compression vs. perceptual)
- Color difference metrics (ΔE) on memory colors
- Vibrance and saturation adjustments

**Color Content Highlights:**
- Red apples & strawberries (critical memory colors)
- Yellow bananas
- Orange citrus
- Green kiwis
- Purple grapes
- Red watermelon flesh

---

### 03. Diverse Skin Tones Portrait
**File:** `skin.png`

**Purpose:**
- Cross-cultural skin tone reproduction accuracy
- Memory color fidelity for human faces
- Subtle color variation and gradient testing
- Caucasian, East Asian, and Sub-Saharan African skin tones in one frame
- Natural smile and eye detail evaluation

**Key Features:**
- Three distinct skin tones side-by-side for direct comparison
- Natural skin texture and pores visible
- Subtle color differences in lips, eyes, and hair
- Excellent for testing "pleasing" vs. "accurate" skin reproduction
- Neutral gray background

**Recommended Tests:**
- Skin tone accuracy under different white balances
- Preferred color reproduction (many users prefer slightly warmer skin)
- Detail preservation in facial features
- Color cast detection in shadows/highlights

**Skin Tone Range:**
- Light / fair Caucasian skin with freckles
- Medium / deep Sub-Saharan African skin
- East Asian skin tone

---

## Technical Specifications

| Image | Dimensions | Color Mode | Profile | Format | Bit Depth |
|-------|------------|------------|---------|--------|-----------|
| 01 B&W Portrait | 960 × 960 px | Grayscale | — | PNG | 8-bit |
| 02 Fruit | 960 × 960 px | RGB | sRGB IEC61966-2.1 | PNG | 8-bit |
| 03 Skin Tones | 960 × 960 px | RGB | sRGB IEC61966-2.1 | PNG | 8-bit |

All images are square for easy tiling/comparison and have been saved at maximum quality (lossless PNG).

---

## License & Attribution

These images were generated using **Grok Imagine** (xAI) specifically for open-source color management development.

**You are free to:**
- Use in any open-source or commercial project
- Modify, resize, or derive new test images
- Redistribute as part of your project

**Recommended attribution** (in README or documentation):
> Test images generated with Grok Imagine • Free for open-source color management use

No warranty is provided regarding color accuracy — these are visual reference images, not certified color targets (for certified targets, consider ISO 12640 SCID or METACOW).

---

*Last updated: May 2026*


*If you find these useful, consider contributing back improvements, additional test cases, or usage examples to the community!*