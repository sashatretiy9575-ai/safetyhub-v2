import { NextResponse } from '@/lib/security/api-response';
import { getAuthContext } from '@/features/auth/server';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const context = await getAuthContext();
    if (!context) {
      return NextResponse.json({ access: 'anonymous' });
    }
    if (context.role === 'admin') {
      return NextResponse.json({ access: 'approved', role: 'admin' });
    }
    if (!context.hasCurrentLegalAcceptance) {
      return NextResponse.json({ access: 'legal_required' });
    }
    if (context.approval.state === 'profile_incomplete') {
      return NextResponse.json({ access: 'profile_incomplete' });
    }
    if (context.approval.state === 'pending') {
      return NextResponse.json({ access: 'pending' });
    }
    if (context.approval.state === 'rejected') {
      return NextResponse.json({ access: 'rejected' });
    }
    return NextResponse.json({ access: 'approved', role: context.role });
  } catch {
    return NextResponse.json({ access: 'anonymous' });
  }
}
