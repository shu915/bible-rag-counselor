// 飾りの星(読み上げの対象にしない)
export function Star({ size, className }: { size: number; className?: string }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" className={className}>
      <path d="M12 1c.8 6.6 3.9 10 11 11-7.1 1-10.2 4.4-11 11-.8-6.6-3.9-10-11-11 7.1-1 10.2-4.4 11-11z" />
    </svg>
  );
}
