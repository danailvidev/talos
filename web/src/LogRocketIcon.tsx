/** Official LogRocket rocket mark (brand purple), used on loop cards and the list. */
export function LogRocketIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" aria-hidden="true">
      <path fill="#764ABC" d="M256 32c-35 0-64 48-64 128v128h128V160c0-80-29-128-64-128z" />
      <path fill="#764ABC" d="M192 256v112c0 35 29 64 64 64s64-29 64-64V256H192z" />
      <path
        fill="#764ABC"
        d="M192 288c-48 0-80 32-80 80v48h48c32 0 48-16 48-48v-80zM320 288v80c0 32 16 48 48 48h48v-48c0-48-32-80-80-80z"
      />
      <path fill="#764ABC" d="M256 416c-16 0-32 16-32 48 0 16 16 16 32 16s32 0 32-16c0-32-16-48-32-48z" />
      <circle cx="256" cy="160" r="24" fill="#FFFFFF" />
    </svg>
  );
}
