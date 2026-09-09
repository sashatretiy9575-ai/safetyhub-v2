import type { ComponentPropsWithoutRef, ReactNode } from 'react';

type SectionShellProps = ComponentPropsWithoutRef<'section'> & {
  id?: string;
  className?: string;
  children: ReactNode;
};

export function SectionShell({
  id,
  className,
  children,
  ...props
}: SectionShellProps) {
  return (
    <section id={id} className={className} {...props}>
      <div className={'mx-auto w-full max-w-[1280px] px-4 md:px-6 xl:px-8'}>{children}</div>
    </section>
  );
}
