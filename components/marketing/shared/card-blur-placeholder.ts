/**
 * A flat neutral tile shown while a card cover is still loading. Without it a
 * lazy cover leaves a hole in the layout, and fast scrolling down the home page
 * reads as "the site did not load" even when nothing is actually slow.
 */
export const CARD_BLUR_PLACEHOLDER =
  'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2240%22 height=%2225%22 viewBox=%220 0 40 25%22%3E%3Crect width=%2240%22 height=%2225%22 fill=%22%23eef1ef%22/%3E%3C/svg%3E';
