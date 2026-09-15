import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function main() {
  console.log('=== Notifications diagnostics ===\n');

  const { count: total, error: countErr } = await supabase
    .from('notifications')
    .select('*', { count: 'exact', head: true });
  console.log('Total rows:', countErr ? `ERROR ${countErr.message}` : total);

  const { data: sample, error: sampleErr } = await supabase
    .from('notifications')
    .select('id, user_id, recipient_pet_id, type, title, body, created_at')
    .order('created_at', { ascending: false })
    .limit(5);
  if (sampleErr) console.log('Sample error:', sampleErr.message);
  else console.log('Recent rows:', JSON.stringify(sample, null, 2));

  const { data: pets } = await supabase.from('pets').select('id, owner_id, name').limit(3);
  const pet = pets?.[0];
  if (!pet) {
    console.log('\nNo pets found — cannot test insert.');
    return;
  }

  console.log('\nTest insert (treat) for pet', pet.name, pet.id, 'owner', pet.owner_id);

  const payload = {
    user_id: pet.owner_id,
    recipient_pet_id: pet.id,
    actor_pet_id: pet.id,
    type: 'treat',
    title: 'Diagnostic Treat',
    body: 'Test notification from diagnose script',
    entity_type: 'post',
    entity_id: pet.id,
    metadata: { diagnostic: true },
    is_read: false,
  };

  const { data: inserted, error: insertErr } = await supabase
    .from('notifications')
    .insert(payload)
    .select()
    .single();

  if (insertErr) {
    console.log('Insert FAILED:', insertErr.message, insertErr.details, insertErr.hint);

    const legacy = {
      recipient_pet_id: pet.id,
      actor_pet_id: pet.id,
      type: 'like',
      entity_type: 'post',
      entity_id: pet.id,
      is_read: false,
    };
    const { data: legacyRow, error: legacyErr } = await supabase
      .from('notifications')
      .insert(legacy)
      .select()
      .single();
    if (legacyErr) console.log('Legacy insert FAILED:', legacyErr.message);
    else {
      console.log('Legacy insert OK:', legacyRow?.id);
      await supabase.from('notifications').delete().eq('id', legacyRow.id);
    }
  } else {
    console.log('Insert OK:', inserted?.id);
    await supabase.from('notifications').delete().eq('id', inserted.id);
  }

  const { data: settingsTable, error: settingsErr } = await supabase
    .from('user_notification_settings')
    .select('user_id')
    .limit(1);
  console.log(
    '\nuser_notification_settings:',
    settingsErr ? `MISSING/ERROR: ${settingsErr.message}` : 'exists'
  );
  if (settingsTable) console.log('Settings sample count check ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
