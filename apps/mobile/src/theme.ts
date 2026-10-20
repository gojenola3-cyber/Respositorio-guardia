export const colors = {
  navy900: '#0b1f3a',
  navy700: '#16335c',
  red600: '#c8102e',
  red700: '#a00d25',
  green600: '#157a3b',
  amber600: '#a35f00',
  amber100: '#fff3dc',
  blue600: '#1f5fbf',
  gray700: '#3f4652',
  gray500: '#6b7280',
  gray300: '#d4d8de',
  gray100: '#f3f5f8',
  white: '#ffffff',
};

export const toneColors = {
  danger: { fg: colors.red700, bg: '#fde7ea' },
  success: { fg: colors.green600, bg: '#e3f4e9' },
  warning: { fg: colors.amber600, bg: colors.amber100 },
  info: { fg: colors.blue600, bg: '#e5eefb' },
  neutral: { fg: colors.gray700, bg: colors.gray100 },
} as const;
