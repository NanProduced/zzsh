// Source: https://platejs.org/r/heading-node.json — Plate UI (MIT)
// Adapted: only h2/h3/h4 exist in the storage whitelist; dropped h1/h5/h6 and
// the nav-target highlight (needs highlight-style registry token not installed).
// `!` suffixes win over the unlayered shared rules in @zzsh/ui/plate-document.css.
import { cva, type VariantProps } from "class-variance-authority";
import { PlateElement, type PlateElementProps } from "platejs/react";

const headingVariants = cva("relative mb-1 font-heading tracking-tight", {
  variants: {
    variant: {
      h2: "mt-[1.4em]! pb-px text-2xl! font-semibold",
      h3: "mt-[1em]! pb-px text-xl! font-semibold",
      h4: "mt-[0.75em]! text-lg! font-semibold",
    },
  },
});

export function HeadingElement({
  variant = "h2",
  ...props
}: PlateElementProps & VariantProps<typeof headingVariants>) {
  return (
    <PlateElement as={variant!} className={headingVariants({ variant })} {...props}>
      {props.children}
    </PlateElement>
  );
}

export function H2Element(props: PlateElementProps) {
  return <HeadingElement variant="h2" {...props} />;
}

export function H3Element(props: PlateElementProps) {
  return <HeadingElement variant="h3" {...props} />;
}

export function H4Element(props: PlateElementProps) {
  return <HeadingElement variant="h4" {...props} />;
}