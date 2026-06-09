export default function VetraMark({ size = 32, className = "" }) {
  return (
    <img
      src="/vetra-logo.png"
      alt=""
      aria-hidden
      className={className}
      width={size}
      height={size}
      draggable={false}
    />
  );
}
