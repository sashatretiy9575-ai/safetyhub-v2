import { Container } from '@/components/ui/container';
import { AppPageLoading } from '@/components/shared/app-state';

export default function Loading() {
  return (
    <Container size="content" className="py-16">
      <AppPageLoading />
    </Container>
  );
}
