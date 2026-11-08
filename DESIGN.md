---
name: Pi Durable Assistant UI
description: Standard Assistant UI chat with native Pi conversation controls.
colors:
  primary: "#171717"
  primary-hover: "#383838"
  surface: "#fff"
  sidebar: "#fafafa"
  muted: "#f5f5f5"
  secondary: "#666"
  border: "#e5e5e5"
  control-border: "#d8d8d8"
  navigation-hover: "#eee"
  navigation-active: "#e9e9e9"
  focus: "#525252"
  placeholder: "#737373"
  link: "#2654a3"
  error: "#a3251a"
  notice: "#306042"
typography:
  headline:
    fontSize: "clamp(24px, 3vw, 32px)"
    fontWeight: 550
    letterSpacing: "-0.03em"
  title:
    fontSize: "15px"
    fontWeight: 550
  body:
    fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "15px"
    lineHeight: 1.75
  label:
    fontSize: "12px"
  code:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "13px"
    lineHeight: 1.6
rounded:
  native-field: "6px"
  native-button: "7px"
  standard: "8px"
  question: "10px"
  message: "15px"
  composer: "16px"
spacing:
  compact: "8px"
  control: "12px"
  standard: "16px"
  section: "24px"
  message: "30px"
  wide: "32px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.surface}"
    rounded: "{rounded.standard}"
    padding: "8px 16px"
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.primary}"
    rounded: "{rounded.native-button}"
    padding: "7px 11px"
  button-text:
    backgroundColor: "transparent"
    textColor: "{colors.secondary}"
    padding: "3px 0"
  native-field:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.primary}"
    rounded: "{rounded.native-field}"
    padding: "8px 10px"
  conversation-item:
    backgroundColor: "transparent"
    textColor: "{colors.primary}"
    rounded: "{rounded.standard}"
    padding: "11px 12px"
  conversation-item-active:
    backgroundColor: "{colors.navigation-active}"
  composer:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.composer}"
    padding: "15px 16px 12px"
  disclosure:
    rounded: "{rounded.standard}"
    padding: "10px 14px"
  user-message:
    backgroundColor: "{colors.muted}"
    textColor: "{colors.primary}"
    rounded: "{rounded.message}"
    padding: "14px 18px"
  human-input:
    backgroundColor: "{colors.sidebar}"
    rounded: "{rounded.question}"
    padding: "18px"
  attachment:
    rounded: "{rounded.standard}"
    padding: "7px 10px 7px 7px"
---

# Design System: Pi Durable Assistant UI

## Overview

**Creative North Star: "Standard Assistant UI"**

Preserve the familiar conversation list, thread, and composer selected in [PRODUCT.md](PRODUCT.md). The interface is quiet, compact around controls, and spacious around messages. Native Pi capabilities fit into this chat composition through disclosures and ordinary form controls.

The implementation in [styles.css](apps/demo/src/styles.css) and the demo components defines the visual system. The tokens here record its reusable values; they are not a separate theme implementation. Functional clarity and predictable browser behavior guide additions.

**Key Characteristics:**

- Grayscale surfaces, dark primary actions, and restrained semantic color.
- A centered conversation column with persistent access to the composer.
- Native disclosures and labeled controls for detailed operations.
- Responsive wrapping, contained overflow, and visible keyboard focus.

## Colors

The palette is predominantly neutral. Primary charcoal carries body text and filled send actions; white is the main surface. The sidebar and user messages use subtle tonal separation. Secondary gray distinguishes supporting labels, while borders define controls and panel divisions. Navigation uses distinct hover and selected tones.

Link blue identifies links; error red and notice green accompany textual outcomes. Focus gray marks keyboard focus and the active composer. Keep status understandable from its text as well as its color.

## Typography

The body stack prefers Inter and falls back to platform sans-serif fonts; the application does not require a downloaded font. Conversation text uses the body role. The empty-state question uses the fluid headline role, while the conversation header uses the title role. Compact labels and text actions use the label size; model information and composer hints are smaller supporting text. Code and tool output use the monospace role.

Message role labels are slightly heavier than conversation prose. Markdown retains headings, lists, links, tables, quotations, and code blocks within the thread's reading width.

## Layout

The desktop shell fills the dynamic viewport height with a fixed sidebar (250px) and a flexible main panel. The header and collapsed controls sit above a scrolling thread. The thread container is centered (maximum 800px); its inner text and composer align at a maximum 736px. The composer footer is sticky at the bottom of the thread viewport. User messages are inset from the left (15%) and assistant messages use the full reading width.

At the mobile breakpoint (760px), the sidebar becomes an off-canvas panel (the smaller of 280px and 84vw) opened by the Conversations button, with a dismissing backdrop. The main panel remains full-height. Horizontal thread padding reduces to 18px, the composer footer to 12px, and the user-message inset to 8%. Actions and suggestions wrap; configuration grids become one column. Tables and code blocks contain their own horizontal overflow, and long message content wraps within the available width.

Expanded conversation controls and harness inspection have their own vertical scrolling limits (48vh and 45vh). Preserve room for the conversation when inspecting detailed native state.

## Elevation & Depth

The interface has no box shadows. Tonal surfaces, thin borders, and whitespace establish separation. Conversation menus overlay nearby content; the mobile sidebar overlays the page with a translucent backdrop. The sidebar slide uses a short ease-out transition (160ms), disabled when the user prefers reduced motion.

## Shapes

Controls and disclosures use modest rounded corners; the user bubble and composer are softer. Borders are thin and neutral. Native form fields retain familiar input and select geometry. Inline code and attachment thumbnails use tighter corners, while the jump-to-latest control is pill-shaped.

## Components

- **Conversation navigation:** a full-width new-conversation action, truncating conversation titles, a tonal active row, and a native More disclosure for renaming. Directory refresh and pagination controls sit below the list. The header pairs the conversation title with model information and textual connection status; deterministic providers are labeled as such.
- **Thread:** user messages have a muted bubble and right-aligned role label; assistant content remains directly on the white surface. Small text actions sit below messages and wrap. Reasoning and tool calls use bordered `details` elements; tools expose their status in text and expand for running results, errors, or files.
- **Composer:** a rounded bordered container holds the labeled textarea, attachments, optional dictation, and send/stop actions. During execution, send steers and a separate action queues a follow-up. Focus is shown on the container using the focus token because the textarea has no separate outline. Enter sends and Shift + Enter inserts a newline. The primary button darkens on hover; disabled buttons have reduced opacity and a disabled cursor.
- **Native controls and inspection:** collapsed `details` rows preserve the thread's prominence. Expanded content uses labeled browser inputs, selects, textareas, ordinary buttons, tables, and bounded monospace output. Success messages use status semantics and actionable errors use alert semantics.
- **Human input:** an inline bordered question panel presents the agent's prompt, a labeled required response field, and a send action. An answered request shows the response in the same panel.
- **Accessibility mechanics:** buttons, textareas, and summaries have a visible two-pixel focus outline with an offset; native configuration inputs and selects have the same focus treatment. Controls retain accessible names, the sidebar toggle exposes its expanded state, connection updates use a polite live status, and errors are announced as alerts. Preserve native keyboard behavior for disclosures and form controls.

## Do's and Don'ts

- **Do** keep the conversation list, thread, and composer as the primary composition.
- **Do** extend existing Assistant UI primitives and native browser controls with the same neutral styling.
- **Do** keep labels, status text, focus indicators, wrapping, and contained overflow when adding controls.
- **Don't** replace the selected standard chat style with a decorative visual identity.
- **Don't** make color the sole indicator of status or errors.
- **Don't** present deterministic provider responses as real model output.
