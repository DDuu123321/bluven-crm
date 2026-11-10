/**
 * Deep link that opens Pylon's map at the address with the customer details filled in.
 * The CRM order number travels as Pylon's reference_number, which is how events coming back
 * from Pylon are matched to the order.
 */
export function pylonDesignLink(input: { address: string; customerName: string; email?: string | null; phone?: string | null; orderNo: string }): string {
  const params = new URLSearchParams({ search: input.address, country: 'AU', customer_name: input.customerName, reference_number: input.orderNo });
  if (input.email) params.set('customer_email', input.email);
  if (input.phone) params.set('customer_phone', input.phone);
  return `https://app.getpylon.com/map/address?${params.toString()}`;
}
