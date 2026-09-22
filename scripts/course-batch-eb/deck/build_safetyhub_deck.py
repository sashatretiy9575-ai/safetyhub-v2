# -*- coding: utf-8 -*-
"""
Generator for:
Обучение по Электробезопасности (ЭБ) и Работам на высоте (Высотным работам)
SafetyHUB Corporate Design System (59 slides, 16:9 widescreen)

Exact design metric fidelity matching SafetyHUB reference course:
- 16:9 widescreen canvas (960 x 540 pt)
- Official SafetyHUB brand palette (#009846 emerald, #E8F5ED mint, #202020 dark charcoal, #5D625F muted, #C52828 / #D93838 red)
- Typography: Arial Bold and Arial Regular with exact point scale
- Signature layouts:
  1. Cover with right photo & green vertical bar
  2. Learning Objectives with numbered rows and mint callout
  3. Five Course Parts with numbered rows and course badge
  4. Section Dividers with Roman numerals, photo & green vertical bar
  5. Signature Content Slide with mint callout & emerald green takeaway
  6. 4-Step Process Pipeline with connector line & green step badges
  7. Risk Matrix Tables with emerald green headers & rounded cards
  8. Two-Card Comparison with ✚ and ✓ badges
  9. Critical STOP Prohibition with red octagon, separator line & reminder
  10. Content with Image & emerald green caption under photo
  11. Full-bleed Emerald Green Checklist Summary closing slide
"""

import os
import pptx
from pptx.util import Pt
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR

import deck_content

# =============================================================================
# DESIGN SYSTEM TOKENS (EXACT MATCH TO SAFETYHUB REFERENCE)
# =============================================================================
SLIDE_WIDTH_PT = 960
SLIDE_HEIGHT_PT = 540

COLOR_BG = RGBColor(255, 255, 255)
COLOR_SECTION_BG = RGBColor(241, 244, 243)      # #F1F4F3
COLOR_TEXT_DARK = RGBColor(32, 32, 32)          # #202020
COLOR_TEXT_MUTED = RGBColor(93, 98, 95)         # #5D625F
COLOR_GREEN = RGBColor(0, 151, 70)              # SafetyHUB Pantone Green #009746
COLOR_GREEN_DARK = RGBColor(23, 107, 72)        # #176B48
COLOR_MINT = RGBColor(232, 245, 237)            # #E8F5ED
COLOR_CARD_BG = RGBColor(241, 244, 243)         # #F1F4F3
COLOR_CARD_BORDER = RGBColor(217, 222, 219)     # #D9DEDB
COLOR_STOP_RED = RGBColor(217, 56, 56)          # #D93838
COLOR_STOP_STRIP = RGBColor(197, 40, 40)        # #C52828
COLOR_STOP_BG = RGBColor(252, 236, 236)         # #FCECEC
COLOR_STOP_SEP = RGBColor(233, 184, 184)        # #E9B8B8
COLOR_WHITE = RGBColor(255, 255, 255)

FONT_FAMILY = "Arial"
LOGO_PATH = "assets/safetyhub_logo.png"


def set_shape_flat(shape, fill_color, border_color=None, border_width_pt=0.75):
    """Utility to set flat fill and border on a shape."""
    if fill_color is not None:
        shape.fill.solid()
        shape.fill.fore_color.rgb = fill_color
    else:
        shape.fill.background()
        
    if border_color is not None:
        shape.line.color.rgb = border_color
        shape.line.width = Pt(border_width_pt)
    else:
        shape.line.fill.background()


def add_common_header_footer(slide, title, slide_num, norm=None):
    """Adds SafetyHUB logo, title with green vertical bar, and standard footer."""
    # Logo top-left
    if os.path.exists(LOGO_PATH):
        slide.shapes.add_picture(LOGO_PATH, Pt(37), Pt(14), width=Pt(150))
        
    # Title vertical green bar (x=42, y=72.8, w=6, h=40.5)
    bar = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, Pt(42), Pt(72.8), Pt(6), Pt(40.5))
    set_shape_flat(bar, COLOR_GREEN)
    
    # Title text
    tb = slide.shapes.add_textbox(Pt(58), Pt(66), Pt(860), Pt(50))
    tf = tb.text_frame
    tf.word_wrap = True
    tf.margin_left = Pt(0)
    tf.margin_top = Pt(0)
    tf.margin_right = Pt(0)
    tf.margin_bottom = Pt(0)
    p = tf.paragraphs[0]
    p.text = title
    p.font.name = FONT_FAMILY
    p.font.bold = True
    p.font.size = Pt(24 if len(title) > 55 else 26)
    p.font.color.rgb = COLOR_TEXT_DARK
    
    # Norm citation placed ABOVE the footer line (x=42, y=485.9)
    if norm:
        norm_tb = slide.shapes.add_textbox(Pt(42), Pt(485.9), Pt(750), Pt(16))
        norm_tf = norm_tb.text_frame
        norm_tf.word_wrap = True
        norm_tf.margin_left = Pt(0)
        norm_tf.margin_top = Pt(0)
        norm_tf.margin_right = Pt(0)
        norm_tf.margin_bottom = Pt(0)
        p_n = norm_tf.paragraphs[0]
        p_n.text = f"Норма: {norm}"
        p_n.font.name = FONT_FAMILY
        p_n.font.size = Pt(10.5)
        p_n.font.color.rgb = COLOR_TEXT_MUTED
    
    # Footer divider line (x=42, y=503.2, w=876, h=0.75)
    line = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, Pt(42), Pt(503.2), Pt(876), Pt(0.75))
    set_shape_flat(line, COLOR_CARD_BORDER)
    
    # Footer text (Left: Course name)
    ft_tb = slide.shapes.add_textbox(Pt(42), Pt(510), Pt(750), Pt(20))
    ft_tf = ft_tb.text_frame
    ft_tf.word_wrap = True
    ft_tf.margin_left = Pt(0)
    ft_tf.margin_top = Pt(0)
    p_ft = ft_tf.paragraphs[0]
    p_ft.text = "Электробезопасность (ЭБ) и работы на высоте • SafetyHUB"
    p_ft.font.name = FONT_FAMILY
    p_ft.font.size = Pt(10.5)
    p_ft.font.color.rgb = COLOR_TEXT_MUTED
    
    # Footer text (Right: Slide number in bold EMERALD GREEN)
    num_tb = slide.shapes.add_textbox(Pt(850), Pt(508), Pt(68), Pt(20))
    num_tf = num_tb.text_frame
    num_tf.margin_right = Pt(0)
    num_tf.margin_top = Pt(0)
    p_num = num_tf.paragraphs[0]
    p_num.alignment = PP_ALIGN.RIGHT
    p_num.text = f"{slide_num:02d}"
    p_num.font.name = FONT_FAMILY
    p_num.font.bold = True
    p_num.font.size = Pt(12)
    p_num.font.color.rgb = COLOR_GREEN


# =============================================================================
# SLIDE LAYOUT BUILDERS
# =============================================================================

def build_cover_slide(prs, data):
    """Slide 01: Cover slide with photo and vertical green accent bar on right."""
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    
    # Left vertical green strip (0, 0, 18, 540)
    strip = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, Pt(0), Pt(0), Pt(18), Pt(SLIDE_HEIGHT_PT))
    set_shape_flat(strip, COLOR_GREEN)
    
    # Logo
    if os.path.exists(LOGO_PATH):
        slide.shapes.add_picture(LOGO_PATH, Pt(42), Pt(25), width=Pt(170))
        
    # Subtitle "УЧЕБНЫЙ КУРС"
    sub_tb = slide.shapes.add_textbox(Pt(42), Pt(115), Pt(495), Pt(25))
    p_sub = sub_tb.text_frame.paragraphs[0]
    p_sub.text = data.get("subtitle", "УЧЕБНЫЙ КУРС")
    p_sub.font.name = FONT_FAMILY
    p_sub.font.bold = True
    p_sub.font.size = Pt(13)
    p_sub.font.color.rgb = COLOR_GREEN
    
    # Main Title
    title_tb = slide.shapes.add_textbox(Pt(42), Pt(138), Pt(495), Pt(115))
    title_tf = title_tb.text_frame
    title_tf.word_wrap = True
    title_tf.margin_left = Pt(0)
    title_tf.margin_top = Pt(0)
    p_title = title_tf.paragraphs[0]
    p_title.text = data["title"]
    p_title.font.name = FONT_FAMILY
    p_title.font.bold = True
    p_title.font.size = Pt(38)
    p_title.font.color.rgb = COLOR_TEXT_DARK
    
    # Accent green horizontal line (w=84, h=6)
    acc_bar = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, Pt(42), Pt(260), Pt(84), Pt(6))
    set_shape_flat(acc_bar, COLOR_GREEN)
    
    # Practical description
    desc_tb = slide.shapes.add_textbox(Pt(42), Pt(282), Pt(495), Pt(95))
    desc_tf = desc_tb.text_frame
    desc_tf.word_wrap = True
    desc_tf.margin_left = Pt(0)
    p_desc = desc_tf.paragraphs[0]
    p_desc.line_spacing = 1.25
    p_desc.text = data["description"]
    p_desc.font.name = FONT_FAMILY
    p_desc.font.size = Pt(17.5)
    p_desc.font.color.rgb = COLOR_TEXT_MUTED
    
    # Target audience
    aud_tb = slide.shapes.add_textbox(Pt(42), Pt(395), Pt(495), Pt(60))
    aud_tf = aud_tb.text_frame
    aud_tf.word_wrap = True
    aud_tf.margin_left = Pt(0)
    p_aud = aud_tf.paragraphs[0]
    p_aud.text = data["audience"]
    p_aud.font.name = FONT_FAMILY
    p_aud.font.size = Pt(13.5)
    p_aud.font.color.rgb = COLOR_TEXT_MUTED
    
    # Vertical green accent bar to the left of the photo (561, 87, 6, 375)
    photo_bar = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, Pt(561), Pt(87), Pt(6), Pt(375))
    set_shape_flat(photo_bar, COLOR_GREEN)
    
    # Photo on right (585, 87, 333, 375)
    photo_path = data.get("photo")
    if photo_path and os.path.exists(photo_path):
        slide.shapes.add_picture(photo_path, Pt(585), Pt(87), width=Pt(333), height=Pt(375))
        
    # Footer line & number
    f_line = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, Pt(42), Pt(503.2), Pt(876), Pt(0.75))
    set_shape_flat(f_line, COLOR_CARD_BORDER)
    
    ft_tb = slide.shapes.add_textbox(Pt(42), Pt(510), Pt(600), Pt(20))
    p_ft = ft_tb.text_frame.paragraphs[0]
    p_ft.text = "Электробезопасность (ЭБ) и работы на высоте • Практический курс SafetyHUB"
    p_ft.font.name = FONT_FAMILY
    p_ft.font.size = Pt(10.5)
    p_ft.font.color.rgb = COLOR_TEXT_MUTED
    
    num_tb = slide.shapes.add_textbox(Pt(850), Pt(508), Pt(68), Pt(20))
    p_num = num_tb.text_frame.paragraphs[0]
    p_num.alignment = PP_ALIGN.RIGHT
    p_num.text = "01"
    p_num.font.name = FONT_FAMILY
    p_num.font.bold = True
    p_num.font.size = Pt(12)
    p_num.font.color.rgb = COLOR_GREEN


def build_learning_objectives_slide(prs, data):
    """Slide 02: 4 objective rows with green numbers & dash lines + mint callout on right."""
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    add_common_header_footer(slide, data["title"], data["slide_num"], data.get("norm"))
    
    # 4 Rows on left (matching reference slide 02 clean layout)
    y_positions = [156, 228, 300, 372]
    for idx, (num_str, text) in enumerate(data["objectives"]):
        y = Pt(y_positions[idx])
        
        # Green number (size 16.6 bold)
        num_box = slide.shapes.add_textbox(Pt(54), y, Pt(36), Pt(30))
        p_num = num_box.text_frame.paragraphs[0]
        p_num.margin_left = Pt(0)
        p_num.margin_top = Pt(0)
        p_num.text = num_str
        p_num.font.name = FONT_FAMILY
        p_num.font.bold = True
        p_num.font.size = Pt(17)
        p_num.font.color.rgb = COLOR_GREEN
        
        # Subtle horizontal dash line (w=33, stroke #D9DEDB)
        dash = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, Pt(96), y + Pt(14), Pt(33), Pt(1.5))
        set_shape_flat(dash, COLOR_CARD_BORDER)
        
        # Objective text
        tb = slide.shapes.add_textbox(Pt(142), y, Pt(485), Pt(58))
        tf = tb.text_frame
        tf.word_wrap = True
        tf.margin_left = Pt(0)
        tf.margin_top = Pt(0)
        p = tf.paragraphs[0]
        p.line_spacing = 1.2
        p.text = text
        p.font.name = FONT_FAMILY
        p.font.size = Pt(16.5)
        p.font.color.rgb = COLOR_TEXT_DARK
        
    # Right mint callout container (650, 156, 268, 270)
    callout = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, Pt(650), Pt(156), Pt(268), Pt(270))
    set_shape_flat(callout, COLOR_MINT)
    
    c_line = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, Pt(650), Pt(156), Pt(6), Pt(270))
    set_shape_flat(c_line, COLOR_GREEN)
    
    c_tb = slide.shapes.add_textbox(Pt(670), Pt(170), Pt(230), Pt(240))
    c_tf = c_tb.text_frame
    c_tf.word_wrap = True
    c_tf.vertical_anchor = MSO_ANCHOR.MIDDLE
    p_c = c_tf.paragraphs[0]
    p_c.text = data["callout_text"]
    p_c.font.name = FONT_FAMILY
    p_c.font.bold = True
    p_c.font.size = Pt(18.5)
    p_c.font.color.rgb = COLOR_GREEN


def build_course_parts_slide(prs, data):
    """Slide 03: 5 course modules on left + right gray container with badge '5'."""
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    add_common_header_footer(slide, data["title"], data["slide_num"], data.get("norm"))
    
    # 5 Rows on left (matching reference slide 03)
    y_positions = [152, 214, 276, 338, 400]
    for idx, (num_str, text) in enumerate(data["parts"]):
        y = Pt(y_positions[idx])
        
        # Green number
        num_box = slide.shapes.add_textbox(Pt(54), y, Pt(36), Pt(30))
        p_num = num_box.text_frame.paragraphs[0]
        p_num.margin_left = Pt(0)
        p_num.margin_top = Pt(0)
        p_num.text = num_str
        p_num.font.name = FONT_FAMILY
        p_num.font.bold = True
        p_num.font.size = Pt(16.5)
        p_num.font.color.rgb = COLOR_GREEN
        
        # Subtle horizontal dash line (w=33)
        dash = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, Pt(96), y + Pt(13), Pt(33), Pt(1.5))
        set_shape_flat(dash, COLOR_CARD_BORDER)
        
        # Part title
        tb = slide.shapes.add_textbox(Pt(142), y, Pt(545), Pt(50))
        tf = tb.text_frame
        tf.word_wrap = True
        tf.margin_left = Pt(0)
        tf.margin_top = Pt(0)
        p = tf.paragraphs[0]
        p.text = text
        p.font.name = FONT_FAMILY
        p.font.size = Pt(16)
        p.font.color.rgb = COLOR_TEXT_DARK
        
    # Right container (715, 156, 195, 250) - light gray fill
    card = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Pt(715), Pt(156), Pt(195), Pt(250))
    set_shape_flat(card, COLOR_CARD_BG, COLOR_CARD_BORDER, 0.75)
    
    # "КУРС" top text
    h_tb = slide.shapes.add_textbox(Pt(715), Pt(175), Pt(195), Pt(25))
    p_h = h_tb.text_frame.paragraphs[0]
    p_h.alignment = PP_ALIGN.CENTER
    p_h.text = data.get("callout_header", "КУРС")
    p_h.font.name = FONT_FAMILY
    p_h.font.bold = True
    p_h.font.size = Pt(14)
    p_h.font.color.rgb = COLOR_GREEN
    
    # Circular green badge with '5' (86x86)
    circle = slide.shapes.add_shape(MSO_SHAPE.OVAL, Pt(770), Pt(208), Pt(86), Pt(86))
    set_shape_flat(circle, COLOR_GREEN)
    p_cir = circle.text_frame.paragraphs[0]
    p_cir.alignment = PP_ALIGN.CENTER
    p_cir.text = data.get("badge_number", "5")
    p_cir.font.name = FONT_FAMILY
    p_cir.font.bold = True
    p_cir.font.size = Pt(38)
    p_cir.font.color.rgb = COLOR_WHITE
    
    # Text below circle: "смысловых блоков"
    c_tb = slide.shapes.add_textbox(Pt(715), Pt(310), Pt(195), Pt(80))
    c_tf = c_tb.text_frame
    c_tf.word_wrap = True
    p_c = c_tf.paragraphs[0]
    p_c.alignment = PP_ALIGN.CENTER
    p_c.text = data["callout_text"]
    p_c.font.name = FONT_FAMILY
    p_c.font.size = Pt(16)
    p_c.font.color.rgb = COLOR_TEXT_MUTED


def build_section_divider(prs, data):
    """Section divider slide (Roman numeral, green underline, section title, photo on right)."""
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    
    # Section background fill (#F1F4F3)
    bg = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, Pt(0), Pt(0), Pt(SLIDE_WIDTH_PT), Pt(SLIDE_HEIGHT_PT))
    set_shape_flat(bg, COLOR_SECTION_BG)
    
    # Left green accent strip
    strip = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, Pt(0), Pt(0), Pt(18), Pt(SLIDE_HEIGHT_PT))
    set_shape_flat(strip, COLOR_GREEN)
    
    # Logo
    if os.path.exists(LOGO_PATH):
        slide.shapes.add_picture(LOGO_PATH, Pt(42), Pt(25), width=Pt(170))
        
    # Roman numeral (size 86pt bold green)
    num_tb = slide.shapes.add_textbox(Pt(54), Pt(105), Pt(200), Pt(95))
    p_num = num_tb.text_frame.paragraphs[0]
    p_num.text = data["roman"]
    p_num.font.name = FONT_FAMILY
    p_num.font.bold = True
    p_num.font.size = Pt(86)
    p_num.font.color.rgb = COLOR_GREEN
    
    # Accent horizontal bar below Roman numeral (54, 218, 84, 6)
    bar = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, Pt(54), Pt(218), Pt(84), Pt(6))
    set_shape_flat(bar, COLOR_GREEN)
    
    # Section title
    title_tb = slide.shapes.add_textbox(Pt(54), Pt(238), Pt(485), Pt(105))
    title_tf = title_tb.text_frame
    title_tf.word_wrap = True
    title_tf.margin_left = Pt(0)
    p_title = title_tf.paragraphs[0]
    p_title.text = data["title"]
    p_title.font.name = FONT_FAMILY
    p_title.font.bold = True
    p_title.font.size = Pt(36)
    p_title.font.color.rgb = COLOR_TEXT_DARK
    
    # Subtitle / Key Message
    sub_tb = slide.shapes.add_textbox(Pt(54), Pt(350), Pt(485), Pt(115))
    sub_tf = sub_tb.text_frame
    sub_tf.word_wrap = True
    sub_tf.margin_left = Pt(0)
    p_sub = sub_tf.paragraphs[0]
    p_sub.line_spacing = 1.25
    p_sub.text = data["subtitle"]
    p_sub.font.name = FONT_FAMILY
    p_sub.font.size = Pt(17.5)
    p_sub.font.color.rgb = COLOR_TEXT_MUTED
    
    # Vertical green accent bar to the left of the photo (561, 90, 6, 385)
    p_bar = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, Pt(561), Pt(90), Pt(6), Pt(385))
    set_shape_flat(p_bar, COLOR_GREEN)
    
    # Photo on right (585, 90, 333, 385)
    photo_path = data.get("photo")
    if photo_path and os.path.exists(photo_path):
        slide.shapes.add_picture(photo_path, Pt(585), Pt(90), width=Pt(333), height=Pt(385))
        
    # Norm above footer line
    norm = data.get("norm")
    if norm:
        norm_tb = slide.shapes.add_textbox(Pt(42), Pt(485.9), Pt(750), Pt(16))
        p_n = norm_tb.text_frame.paragraphs[0]
        p_n.text = f"Норма: {norm}"
        p_n.font.name = FONT_FAMILY
        p_n.font.size = Pt(10.5)
        p_n.font.color.rgb = COLOR_TEXT_MUTED
        
    # Footer line & number
    f_line = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, Pt(42), Pt(503.2), Pt(876), Pt(0.75))
    set_shape_flat(f_line, COLOR_CARD_BORDER)
    
    ft_tb = slide.shapes.add_textbox(Pt(42), Pt(510), Pt(700), Pt(20))
    p_ft = ft_tb.text_frame.paragraphs[0]
    p_ft.text = "Электробезопасность (ЭБ) и работы на высоте • SafetyHUB"
    p_ft.font.name = FONT_FAMILY
    p_ft.font.size = Pt(10.5)
    p_ft.font.color.rgb = COLOR_TEXT_MUTED
    
    num_tb = slide.shapes.add_textbox(Pt(850), Pt(508), Pt(68), Pt(20))
    p_num = num_tb.text_frame.paragraphs[0]
    p_num.alignment = PP_ALIGN.RIGHT
    p_num.text = f"{data['slide_num']:02d}"
    p_num.font.name = FONT_FAMILY
    p_num.font.bold = True
    p_num.font.size = Pt(12)
    p_num.font.color.rgb = COLOR_GREEN


def build_content_with_mint_callout(prs, data):
    """The signature SafetyHUB content slide with rich bullets on left and mint callout on right."""
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    add_common_header_footer(slide, data["title"], data["slide_num"], data.get("norm"))
    
    # Left content box (54, 132, 605, 345)
    bullets = data.get("bullets", [])
    tb = slide.shapes.add_textbox(Pt(54), Pt(132), Pt(605), Pt(345))
    tf = tb.text_frame
    tf.word_wrap = True
    tf.margin_left = Pt(0)
    tf.margin_top = Pt(0)
    tf.margin_right = Pt(0)
    tf.margin_bottom = Pt(0)
    
    # Adaptive typography depending on bullet count & character length
    num_bullets = len(bullets)
    total_chars = sum(len(b) for b in bullets)
    
    if num_bullets <= 3:
        prefix_size = Pt(17)
        rest_size = Pt(16)
        space_after = Pt(12)
        line_spacing = 1.25
    elif num_bullets == 4 and total_chars <= 420:
        prefix_size = Pt(16)
        rest_size = Pt(15)
        space_after = Pt(8)
        line_spacing = 1.20
    elif num_bullets == 4:
        prefix_size = Pt(14.5)
        rest_size = Pt(13.5)
        space_after = Pt(5)
        line_spacing = 1.15
    elif num_bullets == 5:
        prefix_size = Pt(13.5)
        rest_size = Pt(12.5)
        space_after = Pt(3.5)
        line_spacing = 1.12
    else:  # 6 or more bullets (e.g. Slide 31)
        prefix_size = Pt(12)
        rest_size = Pt(11.5)
        space_after = Pt(2.5)
        line_spacing = 1.08
    
    for idx, bullet_text in enumerate(bullets):
        p = tf.paragraphs[0] if idx == 0 else tf.add_paragraph()
        p.space_after = space_after
        p.line_spacing = line_spacing
        
        # Parse bold prefix: e.g. "• Определение: остальной текст..."
        if ":" in bullet_text:
            parts = bullet_text.split(":", 1)
            prefix = parts[0] + ":"
            rest = parts[1]
            
            run_prefix = p.add_run()
            run_prefix.text = prefix
            run_prefix.font.name = FONT_FAMILY
            run_prefix.font.bold = True
            run_prefix.font.size = prefix_size
            run_prefix.font.color.rgb = COLOR_TEXT_DARK
            
            run_rest = p.add_run()
            run_rest.text = rest
            run_rest.font.name = FONT_FAMILY
            run_rest.font.bold = False
            run_rest.font.size = rest_size
            run_rest.font.color.rgb = COLOR_TEXT_DARK
        else:
            run = p.add_run()
            run.text = bullet_text
            run.font.name = FONT_FAMILY
            run.font.size = rest_size
            run.font.color.rgb = COLOR_TEXT_DARK
            
    # Right mint callout container (675, 132, 243, 345)
    callout = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, Pt(675), Pt(132), Pt(243), Pt(345))
    set_shape_flat(callout, COLOR_MINT)
    
    c_line = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, Pt(675), Pt(132), Pt(6), Pt(345))
    set_shape_flat(c_line, COLOR_GREEN)
    
    c_tb = slide.shapes.add_textbox(Pt(695), Pt(142), Pt(208), Pt(325))
    c_tf = c_tb.text_frame
    c_tf.word_wrap = True
    c_tf.margin_left = Pt(0)
    c_tf.margin_top = Pt(0)
    c_tf.margin_right = Pt(0)
    c_tf.margin_bottom = Pt(0)
    c_tf.vertical_anchor = MSO_ANCHOR.MIDDLE
    p_c = c_tf.paragraphs[0]
    p_c.text = data["callout_text"]
    p_c.font.name = FONT_FAMILY
    p_c.font.bold = True
    p_c.font.size = Pt(16 if len(data["callout_text"]) > 90 else 18)
    p_c.font.color.rgb = COLOR_GREEN


def build_4step_process(prs, data):
    """4-step horizontal process / pipeline slide with circular badges and connector line."""
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    add_common_header_footer(slide, data["title"], data["slide_num"], data.get("norm"))
    
    # Connector horizontal line (106.5, 205, 745.5, 3)
    conn = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, Pt(106.5), Pt(205), Pt(745.5), Pt(3))
    set_shape_flat(conn, COLOR_CARD_BORDER)
    
    # 4 Steps: x-positions
    x_positions = [90, 315, 540, 765]
    badge_size = 66
    
    for idx, (step_num, step_name, step_desc) in enumerate(data["steps"]):
        x = x_positions[idx]
        
        # Circular step badge (66x66)
        circle = slide.shapes.add_shape(MSO_SHAPE.OVAL, Pt(x + 42), Pt(172), Pt(badge_size), Pt(badge_size))
        set_shape_flat(circle, COLOR_GREEN)
        tf_c = circle.text_frame
        p_c = tf_c.paragraphs[0]
        p_c.alignment = PP_ALIGN.CENTER
        p_c.text = str(step_num)
        p_c.font.name = FONT_FAMILY
        p_c.font.bold = True
        p_c.font.size = Pt(25.4)
        p_c.font.color.rgb = COLOR_WHITE
        
        # Step title
        title_tb = slide.shapes.add_textbox(Pt(x - 20), Pt(255), Pt(190), Pt(35))
        tf_t = title_tb.text_frame
        tf_t.word_wrap = True
        tf_t.margin_left = Pt(0)
        p_t = tf_t.paragraphs[0]
        p_t.alignment = PP_ALIGN.CENTER
        p_t.text = step_name
        p_t.font.name = FONT_FAMILY
        p_t.font.bold = True
        p_t.font.size = Pt(17.5)
        p_t.font.color.rgb = COLOR_TEXT_DARK
        
        # Step description
        desc_tb = slide.shapes.add_textbox(Pt(x - 20), Pt(295), Pt(190), Pt(110))
        tf_d = desc_tb.text_frame
        tf_d.word_wrap = True
        tf_d.margin_left = Pt(0)
        p_d = tf_d.paragraphs[0]
        p_d.alignment = PP_ALIGN.CENTER
        p_d.line_spacing = 1.15
        p_d.text = step_desc
        p_d.font.name = FONT_FAMILY
        p_d.font.size = Pt(12.5)
        p_d.font.color.rgb = COLOR_TEXT_MUTED
        
    # Bottom highlight banner (60, 416, 840, 48)
    banner = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Pt(60), Pt(416), Pt(840), Pt(48))
    set_shape_flat(banner, COLOR_MINT, COLOR_CARD_BORDER, 0.75)
    
    b_line = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, Pt(60), Pt(422), Pt(5), Pt(36))
    set_shape_flat(b_line, COLOR_GREEN)
    
    b_tb = slide.shapes.add_textbox(Pt(75), Pt(421), Pt(810), Pt(38))
    b_tf = b_tb.text_frame
    b_tf.word_wrap = True
    b_tf.margin_left = Pt(0)
    b_tf.margin_top = Pt(0)
    b_tf.margin_right = Pt(0)
    b_tf.margin_bottom = Pt(0)
    p_b = b_tf.paragraphs[0]
    p_b.alignment = PP_ALIGN.CENTER
    p_b.text = data["bottom_banner"]
    p_b.font.name = FONT_FAMILY
    p_b.font.bold = True
    p_b.font.size = Pt(13)
    p_b.font.color.rgb = COLOR_GREEN


def build_risk_table(prs, data):
    """Table / Risk Matrix slide with emerald green headers and alternating rounded cards."""
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    add_common_header_footer(slide, data["title"], data["slide_num"], data.get("norm"))
    
    # Headers in emerald green (exact match to reference slide 06)
    h_col1 = slide.shapes.add_textbox(Pt(54), Pt(135), Pt(200), Pt(24))
    p1 = h_col1.text_frame.paragraphs[0]
    p1.text = data["headers"][0]
    p1.font.name = FONT_FAMILY
    p1.font.bold = True
    p1.font.size = Pt(12.7)
    p1.font.color.rgb = COLOR_GREEN
    
    h_col2 = slide.shapes.add_textbox(Pt(270), Pt(135), Pt(275), Pt(24))
    p2 = h_col2.text_frame.paragraphs[0]
    p2.text = data["headers"][1]
    p2.font.name = FONT_FAMILY
    p2.font.bold = True
    p2.font.size = Pt(12.7)
    p2.font.color.rgb = COLOR_GREEN
    
    h_col3 = slide.shapes.add_textbox(Pt(565), Pt(135), Pt(350), Pt(24))
    p3 = h_col3.text_frame.paragraphs[0]
    p3.text = data["headers"][2]
    p3.font.name = FONT_FAMILY
    p3.font.bold = True
    p3.font.size = Pt(12.7)
    p3.font.color.rgb = COLOR_GREEN
    
    # Data rows (54, y, 861, 54)
    y_positions = [160, 222, 284, 346]
    for idx, (col1_txt, col2_txt, col3_txt) in enumerate(data["rows"]):
        y = Pt(y_positions[idx])
        fill_col = COLOR_CARD_BG if (idx % 2 == 0) else COLOR_WHITE
        
        row_card = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Pt(54), y, Pt(861), Pt(54))
        set_shape_flat(row_card, fill_col, COLOR_CARD_BORDER, 0.75)
        
        # Col 1
        t1 = slide.shapes.add_textbox(Pt(66), y + Pt(6), Pt(190), Pt(42))
        tf1 = t1.text_frame
        tf1.word_wrap = True
        pt1 = tf1.paragraphs[0]
        pt1.text = col1_txt
        pt1.font.name = FONT_FAMILY
        pt1.font.bold = True
        pt1.font.size = Pt(14.5)
        pt1.font.color.rgb = COLOR_TEXT_DARK
        
        # Col 2
        t2 = slide.shapes.add_textbox(Pt(270), y + Pt(6), Pt(275), Pt(42))
        tf2 = t2.text_frame
        tf2.word_wrap = True
        pt2 = tf2.paragraphs[0]
        pt2.text = col2_txt
        pt2.font.name = FONT_FAMILY
        pt2.font.size = Pt(13)
        pt2.font.color.rgb = COLOR_TEXT_MUTED
        
        # Col 3
        t3 = slide.shapes.add_textbox(Pt(565), y + Pt(6), Pt(340), Pt(42))
        tf3 = t3.text_frame
        tf3.word_wrap = True
        pt3 = tf3.paragraphs[0]
        pt3.text = col3_txt
        pt3.font.name = FONT_FAMILY
        pt3.font.size = Pt(13)
        pt3.font.color.rgb = COLOR_TEXT_DARK
        
    # Bottom takeaway: centered bold emerald green text
    b_tb = slide.shapes.add_textbox(Pt(54), Pt(418), Pt(861), Pt(30))
    p_b = b_tb.text_frame.paragraphs[0]
    p_b.alignment = PP_ALIGN.CENTER
    p_b.text = data["bottom_banner"]
    p_b.font.name = FONT_FAMILY
    p_b.font.bold = True
    p_b.font.size = Pt(13.5)
    p_b.font.color.rgb = COLOR_GREEN


def build_two_card_comparison(prs, data):
    """Two distinct cards comparison with ✚ and ✓ badges and bottom summary bar."""
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    add_common_header_footer(slide, data["title"], data["slide_num"], data.get("norm"))
    
    # Left Card (54, 132, 411, 252) - light gray fill
    card_l = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Pt(54), Pt(132), Pt(411), Pt(252))
    set_shape_flat(card_l, COLOR_CARD_BG, COLOR_CARD_BORDER, 0.75)
    
    bar_l = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, Pt(54), Pt(144), Pt(4.5), Pt(228))
    set_shape_flat(bar_l, COLOR_GREEN)
    
    # Badge circle left (dark green #176B48)
    badge_l = slide.shapes.add_shape(MSO_SHAPE.OVAL, Pt(73.5), Pt(146), Pt(40), Pt(40))
    set_shape_flat(badge_l, COLOR_GREEN_DARK)
    p_bl = badge_l.text_frame.paragraphs[0]
    p_bl.alignment = PP_ALIGN.CENTER
    p_bl.text = "✚" if data.get("left_card_badge") == "1" else str(data.get("left_card_badge", "✚"))
    p_bl.font.name = FONT_FAMILY
    p_bl.font.bold = True
    p_bl.font.size = Pt(19)
    p_bl.font.color.rgb = COLOR_WHITE
    
    # Title left
    tl_tb = slide.shapes.add_textbox(Pt(125), Pt(152), Pt(320), Pt(28))
    p_tl = tl_tb.text_frame.paragraphs[0]
    p_tl.text = data["left_card_title"]
    p_tl.font.name = FONT_FAMILY
    p_tl.font.bold = True
    p_tl.font.size = Pt(16.5)
    p_tl.font.color.rgb = COLOR_GREEN_DARK
    
    # Bullets left
    bl_tb = slide.shapes.add_textbox(Pt(73.5), Pt(194), Pt(375), Pt(180))
    bl_tf = bl_tb.text_frame
    bl_tf.word_wrap = True
    bl_tf.margin_left = Pt(0)
    bl_tf.margin_top = Pt(0)
    bl_tf.margin_right = Pt(0)
    bl_tf.margin_bottom = Pt(0)
    for idx, b_text in enumerate(data["left_card_bullets"]):
        p = bl_tf.paragraphs[0] if idx == 0 else bl_tf.add_paragraph()
        p.space_after = Pt(3.5)
        p.line_spacing = 1.15
        p.text = b_text
        p.font.name = FONT_FAMILY
        p.font.size = Pt(12)
        p.font.color.rgb = COLOR_TEXT_DARK
        
    # Right Card (487.5, 132, 411, 252) - mint fill
    card_r = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Pt(487.5), Pt(132), Pt(411), Pt(252))
    set_shape_flat(card_r, COLOR_MINT, COLOR_CARD_BORDER, 0.75)
    
    bar_r = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, Pt(487.5), Pt(144), Pt(4.5), Pt(228))
    set_shape_flat(bar_r, COLOR_GREEN)
    
    # Badge circle right (emerald green #009746)
    badge_r = slide.shapes.add_shape(MSO_SHAPE.OVAL, Pt(507), Pt(146), Pt(40), Pt(40))
    set_shape_flat(badge_r, COLOR_GREEN)
    p_br = badge_r.text_frame.paragraphs[0]
    p_br.alignment = PP_ALIGN.CENTER
    p_br.text = "✓" if data.get("right_card_badge") == "2" else str(data.get("right_card_badge", "✓"))
    p_br.font.name = FONT_FAMILY
    p_br.font.bold = True
    p_br.font.size = Pt(19)
    p_br.font.color.rgb = COLOR_WHITE
    
    # Title right
    tr_tb = slide.shapes.add_textbox(Pt(558), Pt(152), Pt(320), Pt(28))
    p_tr = tr_tb.text_frame.paragraphs[0]
    p_tr.text = data["right_card_title"]
    p_tr.font.name = FONT_FAMILY
    p_tr.font.bold = True
    p_tr.font.size = Pt(16.5)
    p_tr.font.color.rgb = COLOR_GREEN_DARK
    
    # Bullets right
    br_tb = slide.shapes.add_textbox(Pt(507), Pt(194), Pt(375), Pt(180))
    br_tf = br_tb.text_frame
    br_tf.word_wrap = True
    br_tf.margin_left = Pt(0)
    br_tf.margin_top = Pt(0)
    br_tf.margin_right = Pt(0)
    br_tf.margin_bottom = Pt(0)
    for idx, b_text in enumerate(data["right_card_bullets"]):
        p = br_tf.paragraphs[0] if idx == 0 else br_tf.add_paragraph()
        p.space_after = Pt(3.5)
        p.line_spacing = 1.15
        p.text = b_text
        p.font.name = FONT_FAMILY
        p.font.size = Pt(12)
        p.font.color.rgb = COLOR_TEXT_DARK
        
    # Bottom summary banner (54, 396, 844.5, 56)
    banner = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Pt(54), Pt(396), Pt(844.5), Pt(56))
    set_shape_flat(banner, COLOR_MINT, COLOR_CARD_BORDER, 0.75)
    
    b_bar = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, Pt(54), Pt(402), Pt(4.5), Pt(44))
    set_shape_flat(b_bar, COLOR_GREEN)
    
    b_tb = slide.shapes.add_textbox(Pt(68), Pt(402), Pt(815), Pt(44))
    b_tf = b_tb.text_frame
    b_tf.word_wrap = True
    b_tf.margin_left = Pt(0)
    b_tf.margin_top = Pt(0)
    b_tf.margin_right = Pt(0)
    b_tf.margin_bottom = Pt(0)
    p_b = b_tf.paragraphs[0]
    p_b.alignment = PP_ALIGN.CENTER
    p_b.text = data["bottom_banner"]
    p_b.font.name = FONT_FAMILY
    p_b.font.bold = True
    p_b.font.size = Pt(13)
    p_b.font.color.rgb = COLOR_GREEN_DARK


def build_stop_prohibition(prs, data):
    """Critical STOP slide with red left strip, red octagon, vertical separator line, and warning reminder."""
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    
    # Left red vertical strip (0, 0, 18, 540)
    strip = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, Pt(0), Pt(0), Pt(18), Pt(SLIDE_HEIGHT_PT))
    set_shape_flat(strip, COLOR_STOP_STRIP)
    
    # Header and Footer
    add_common_header_footer(slide, data["title"], data["slide_num"], data.get("norm"))
    
    # Container soft pink/red box (54, 132, 861, 286)
    box = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Pt(54), Pt(132), Pt(861), Pt(286))
    set_shape_flat(box, COLOR_STOP_BG)
    
    # STOP Octagon badge (78, 210, 126, 126)
    oct_shape = slide.shapes.add_shape(MSO_SHAPE.OCTAGON, Pt(78), Pt(210), Pt(126), Pt(126))
    set_shape_flat(oct_shape, COLOR_STOP_RED, RGBColor(184, 34, 34), 1.5)
    tf_oct = oct_shape.text_frame
    tf_oct.margin_left = Pt(0)
    tf_oct.margin_right = Pt(0)
    tf_oct.margin_top = Pt(0)
    tf_oct.margin_bottom = Pt(0)
    tf_oct.word_wrap = False
    tf_oct.vertical_anchor = MSO_ANCHOR.MIDDLE
    p_oct = tf_oct.paragraphs[0]
    p_oct.alignment = PP_ALIGN.CENTER
    p_oct.text = "СТОП"
    p_oct.font.name = FONT_FAMILY
    p_oct.font.bold = True
    p_oct.font.size = Pt(23)
    p_oct.font.color.rgb = COLOR_WHITE
    
    # Vertical separator line inside container (238.5, 144, 1.5, 262)
    sep = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, Pt(238.5), Pt(144), Pt(1.5), Pt(262))
    set_shape_flat(sep, COLOR_STOP_SEP)
    
    # Prohibition bullets (265, 140, 630, 270)
    c_tb = slide.shapes.add_textbox(Pt(265), Pt(140), Pt(630), Pt(270))
    c_tf = c_tb.text_frame
    c_tf.word_wrap = True
    c_tf.margin_left = Pt(0)
    c_tf.margin_top = Pt(0)
    c_tf.margin_right = Pt(0)
    c_tf.margin_bottom = Pt(0)
    
    num_bullets = len(data["bullets"])
    if num_bullets <= 4:
        font_size = Pt(14)
        space_after = Pt(6)
        line_spacing = 1.16
    elif num_bullets == 5:
        font_size = Pt(12.5)
        space_after = Pt(4)
        line_spacing = 1.12
    else:  # 6 bullets (Slide 58)
        font_size = Pt(11.5)
        space_after = Pt(2.5)
        line_spacing = 1.08
    
    for idx, b_text in enumerate(data["bullets"]):
        p = c_tf.paragraphs[0] if idx == 0 else c_tf.add_paragraph()
        p.space_after = space_after
        p.line_spacing = line_spacing
        p.text = b_text
        p.font.name = FONT_FAMILY
        p.font.size = font_size
        p.font.color.rgb = COLOR_TEXT_DARK
        
    # Bottom red reminder line
    b_tb = slide.shapes.add_textbox(Pt(54), Pt(426), Pt(861), Pt(26))
    b_tf = b_tb.text_frame
    b_tf.word_wrap = True
    b_tf.margin_left = Pt(0)
    b_tf.margin_top = Pt(0)
    b_tf.margin_right = Pt(0)
    b_tf.margin_bottom = Pt(0)
    p_b = b_tf.paragraphs[0]
    p_b.alignment = PP_ALIGN.CENTER
    p_b.text = data["bottom_banner"]
    p_b.font.name = FONT_FAMILY
    p_b.font.bold = True
    p_b.font.size = Pt(13)
    p_b.font.color.rgb = COLOR_STOP_STRIP


def build_content_with_image(prs, data):
    """Content slide with bullets on left, technical photo on right, and bold green caption below photo."""
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    add_common_header_footer(slide, data["title"], data["slide_num"], data.get("norm"))
    
    # Left content box (54, 132, 530, 345)
    bullets = data.get("bullets", [])
    tb = slide.shapes.add_textbox(Pt(54), Pt(132), Pt(530), Pt(345))
    tf = tb.text_frame
    tf.word_wrap = True
    tf.margin_left = Pt(0)
    tf.margin_top = Pt(0)
    tf.margin_right = Pt(0)
    tf.margin_bottom = Pt(0)
    
    num_bullets = len(bullets)
    total_chars = sum(len(b) for b in bullets)
    if num_bullets <= 3:
        prefix_size = Pt(15.5)
        rest_size = Pt(14.5)
        space_after = Pt(10)
        line_spacing = 1.20
    elif num_bullets == 4:
        prefix_size = Pt(13.5)
        rest_size = Pt(12.5)
        space_after = Pt(4.5)
        line_spacing = 1.15
    else:
        prefix_size = Pt(12)
        rest_size = Pt(11.5)
        space_after = Pt(3)
        line_spacing = 1.12
    
    for idx, bullet_text in enumerate(bullets):
        p = tf.paragraphs[0] if idx == 0 else tf.add_paragraph()
        p.space_after = space_after
        p.line_spacing = line_spacing
        
        if ":" in bullet_text:
            parts = bullet_text.split(":", 1)
            prefix = parts[0] + ":"
            rest = parts[1]
            
            run_prefix = p.add_run()
            run_prefix.text = prefix
            run_prefix.font.name = FONT_FAMILY
            run_prefix.font.bold = True
            run_prefix.font.size = prefix_size
            run_prefix.font.color.rgb = COLOR_TEXT_DARK
            
            run_rest = p.add_run()
            run_rest.text = rest
            run_rest.font.name = FONT_FAMILY
            run_rest.font.size = rest_size
            run_rest.font.color.rgb = COLOR_TEXT_DARK
        else:
            run = p.add_run()
            run.text = bullet_text
            run.font.name = FONT_FAMILY
            run.font.size = rest_size
            run.font.color.rgb = COLOR_TEXT_DARK
            
    # Right photo (600, 132, 315, 240)
    photo_path = data.get("photo")
    if photo_path and os.path.exists(photo_path):
        slide.shapes.add_picture(photo_path, Pt(600), Pt(132), width=Pt(315), height=Pt(240))
        
    # Signature key takeaway under photo in bold emerald green
    caption = data.get("callout_text") or data.get("bottom_banner")
    if caption:
        cap_tb = slide.shapes.add_textbox(Pt(600), Pt(382), Pt(315), Pt(65))
        cap_tf = cap_tb.text_frame
        cap_tf.word_wrap = True
        cap_tf.margin_left = Pt(0)
        cap_tf.margin_top = Pt(0)
        cap_tf.margin_right = Pt(0)
        cap_tf.margin_bottom = Pt(0)
        p_cap = cap_tf.paragraphs[0]
        p_cap.text = caption
        p_cap.font.name = FONT_FAMILY
        p_cap.font.bold = True
        p_cap.font.size = Pt(11.5 if len(caption) > 85 else 12.5)
        p_cap.line_spacing = 1.10 if len(caption) > 85 else 1.14
        p_cap.font.color.rgb = COLOR_GREEN


def build_checklist_summary(prs, data):
    """Slide 59: Signature SafetyHUB closing checklist on full-bleed EMERALD GREEN background."""
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    
    # Full-bleed emerald green background (0, 0, 960, 540)
    bg = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, Pt(0), Pt(0), Pt(SLIDE_WIDTH_PT), Pt(SLIDE_HEIGHT_PT))
    set_shape_flat(bg, COLOR_GREEN)
    
    # White rounded container for SafetyHUB logo at top-left (37, 12.5, 187, 54)
    logo_bg = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Pt(37), Pt(12.5), Pt(187), Pt(54))
    set_shape_flat(logo_bg, COLOR_WHITE)
    
    if os.path.exists(LOGO_PATH):
        slide.shapes.add_picture(LOGO_PATH, Pt(47), Pt(17), width=Pt(167))
        
    # Title in white bold (54, 76, 850, 46) - single line fit at Pt(27)
    title_tb = slide.shapes.add_textbox(Pt(54), Pt(76), Pt(850), Pt(46))
    tf_title = title_tb.text_frame
    tf_title.word_wrap = True
    tf_title.margin_left = Pt(0)
    tf_title.margin_top = Pt(0)
    tf_title.margin_right = Pt(0)
    tf_title.margin_bottom = Pt(0)
    p_t = tf_title.paragraphs[0]
    p_t.text = data.get("title", "Итоговый чек-лист допуска: 6 условий безопасности")
    p_t.font.name = FONT_FAMILY
    p_t.font.bold = True
    p_t.font.size = Pt(27)
    p_t.font.color.rgb = COLOR_WHITE
    
    # 6 checklist items (matching reference slide 59)
    checklist = data["checklist"]
    y_positions = [134, 184, 234, 284, 334, 384]
    
    for idx, item in enumerate(checklist[:6]):
        y = Pt(y_positions[idx])
        item_title, item_desc = item if isinstance(item, (list, tuple)) else (item, "")
        
        # White circular badge (32 x 32)
        circle = slide.shapes.add_shape(MSO_SHAPE.OVAL, Pt(54), y, Pt(32), Pt(32))
        set_shape_flat(circle, COLOR_WHITE)
        p_c = circle.text_frame.paragraphs[0]
        p_c.alignment = PP_ALIGN.CENTER
        p_c.text = "✓"
        p_c.font.name = FONT_FAMILY
        p_c.font.bold = True
        p_c.font.size = Pt(17)
        p_c.font.color.rgb = COLOR_GREEN
        
        # Text: bold title + normal description
        tb = slide.shapes.add_textbox(Pt(98), y + Pt(1), Pt(815), Pt(42))
        tf = tb.text_frame
        tf.word_wrap = True
        tf.margin_left = Pt(0)
        tf.margin_top = Pt(0)
        tf.margin_right = Pt(0)
        tf.margin_bottom = Pt(0)
        p = tf.paragraphs[0]
        
        run_title = p.add_run()
        run_title.text = item_title + (" — " if item_desc else "")
        run_title.font.name = FONT_FAMILY
        run_title.font.bold = True
        run_title.font.size = Pt(15.5)
        run_title.font.color.rgb = COLOR_WHITE
        
        if item_desc:
            run_desc = p.add_run()
            run_desc.text = item_desc
            run_desc.font.name = FONT_FAMILY
            run_desc.font.bold = False
            run_desc.font.size = Pt(14.5)
            run_desc.font.color.rgb = COLOR_WHITE
            
    # Bottom action bar (Left: button action prompt, Right: updated date)
    btn_tb = slide.shapes.add_textbox(Pt(54), Pt(475), Pt(500), Pt(30))
    p_btn = btn_tb.text_frame.paragraphs[0]
    p_btn.text = data.get("button_text", "Нажмите «Начать проверку знаний»")
    p_btn.font.name = FONT_FAMILY
    p_btn.font.bold = True
    p_btn.font.size = Pt(15)
    p_btn.font.color.rgb = COLOR_WHITE
    
    date_tb = slide.shapes.add_textbox(Pt(700), Pt(475), Pt(210), Pt(30))
    p_date = date_tb.text_frame.paragraphs[0]
    p_date.alignment = PP_ALIGN.RIGHT
    p_date.text = data.get("date_text", "Актуализировано: 2026")
    p_date.font.name = FONT_FAMILY
    p_date.font.size = Pt(12.5)
    p_date.font.color.rgb = COLOR_WHITE


# =============================================================================
# MAIN ORCHESTRATOR
# =============================================================================

def generate_presentation(output_filename="Обучение_ЭБ_и_Высотные_Работы_SafetyHUB.pptx"):
    prs = pptx.Presentation()
    prs.slide_width = Pt(SLIDE_WIDTH_PT)
    prs.slide_height = Pt(SLIDE_HEIGHT_PT)
    
    print(f"Starting presentation generation with {len(deck_content.SLIDES_DATA)} slides...")
    
    for slide_data in deck_content.SLIDES_DATA:
        s_num = slide_data["slide_num"]
        layout = slide_data["layout"]
        
        if layout == "cover":
            build_cover_slide(prs, slide_data)
        elif layout == "learning_objectives":
            build_learning_objectives_slide(prs, slide_data)
        elif layout == "course_parts":
            build_course_parts_slide(prs, slide_data)
        elif layout == "section_divider":
            build_section_divider(prs, slide_data)
        elif layout == "content_with_mint_callout":
            build_content_with_mint_callout(prs, slide_data)
        elif layout == "4step_process":
            build_4step_process(prs, slide_data)
        elif layout == "risk_table":
            build_risk_table(prs, slide_data)
        elif layout == "two_card_comparison":
            build_two_card_comparison(prs, slide_data)
        elif layout == "stop_prohibition":
            build_stop_prohibition(prs, slide_data)
        elif layout == "content_with_image":
            build_content_with_image(prs, slide_data)
        elif layout == "checklist_summary":
            build_checklist_summary(prs, slide_data)
        else:
            print(f"Warning: Unknown layout '{layout}' on slide {s_num}")
            
    prs.save(output_filename)
    print(f"Successfully generated presentation: {output_filename}")
    print(f"Total slides in presentation: {len(prs.slides)}")


if __name__ == "__main__":
    generate_presentation()
