import { NextRequest, NextResponse } from 'next/server';
import { getEarningsHistory, isValidStellarAddress } from '@/lib/affiliate-store';
import { createProblemResponse } from '@/lib/api-contracts/problem-details';

/**
 * GET /api/affiliates/earnings?wallet=<address>&days=<number>
 * Fetch earnings history for charts, aggregated from the affiliate store's
 * referral ledger (the same source the stats endpoint reads). Returns an
 * empty array when the wallet has no converted referrals — not an error.
 */
export async function GET(request: NextRequest) {
  try {
    const wallet = request.nextUrl.searchParams.get('wallet');
    const daysParam = request.nextUrl.searchParams.get('days');
    const days = daysParam ? parseInt(daysParam, 10) : 30;

    if (!wallet) {
      return createProblemResponse('WALLET_REQUIRED', { instance: request.nextUrl.pathname });
    }

    // Validate Stellar address format
    if (!isValidStellarAddress(wallet)) {
      return createProblemResponse('INVALID_WALLET_ADDRESS', { instance: request.nextUrl.pathname });
    }

    // Validate days parameter
    if (isNaN(days) || days < 1 || days > 365) {
      return createProblemResponse('INVALID_RANGE', { instance: request.nextUrl.pathname });
    }

    return NextResponse.json(getEarningsHistory(wallet, days));
  } catch (error) {
    // Raw errors stay in protected logs; the response carries only the
    // registry-sanitized message and a correlation id.
    console.error('Error fetching earnings history:', error);
    return createProblemResponse('INTERNAL_ERROR', { instance: request.nextUrl.pathname });
  }
}
