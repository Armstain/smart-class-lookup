import React from "react";

// 1. Simple className string replacement
export function Button() {
  return (
    <button className="px-4 py-2 bg-red-500 text-white rounded hover:bg-red-600 transition-colors">
      Click Me
    </button>
  );
}

// 2. Class lists spread across conditional expressions (ternaries and logical &&)
export function ConditionalCard({ isActive, isSecondary }) {
  return (
    <div
      className={cn(
        "p-6 border rounded-lg",
        isActive ? "bg-red-500 text-white" : "bg-white text-gray-800",
        isSecondary && "shadow-lg border-red-500"
      )}
    >
      <h3>Card Title</h3>
      <p>Card content goes here...</p>
    </div>
  );
}

// 3. Class lists in template literals
export function Hero({ size }) {
  const sizeClass = size === "lg" ? "h-96" : "h-64";
  return (
    <section className={`relative w-full flex items-center justify-center bg-red-500 ${sizeClass}`}>
      <h1 className="text-4xl font-bold text-white">Welcome Hero</h1>
    </section>
  );
}

// 4. Class lists in arrays
export function List() {
  const items = ["bg-red-500", "p-4", "rounded"];
  return <div className={cn(items)}>List Container</div>;
}

// 5. Class lists in clsx object notation
export function Alert({ isError }) {
  return (
    <div
      className={clsx({
        "bg-red-500": isError,
        "text-white": isError,
        "p-4 border rounded": true,
      })}
    >
      Alert Message
    </div>
  );
}

// 6. Local variable resolution
export function Widget() {
  const widgetStyles = cn("flex items-center space-x-2 bg-red-500 p-3 rounded-md");
  return <div className={widgetStyles}>Widget content</div>;
}
