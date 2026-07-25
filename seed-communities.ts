import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
import path from 'path'
dotenv.config({ path: path.join(__dirname, '.env') })

const supabaseUrl = process.env.SUPABASE_URL
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('❌ Environment variables SUPABASE_URL or SUPABASE_SERVICE_KEY are missing.')
  process.exit(1)
}

const supabase = createClient(supabaseUrl, supabaseServiceKey)

const communities = [
  {
    name: 'Indiranagar Dogs Pack',
    slug: 'indiranagar-dogs',
    description: 'The official pack for dogs residing in and around Indiranagar, Bangalore. Join us for weekend playdates and sharing local pet care recommendations!',
    cover_image_url: 'https://images.unsplash.com/photo-1548199973-03cce0bbc87b?auto=format&fit=crop&q=80&w=800',
  },
  {
    name: 'Mumbai Retriever Club',
    slug: 'mumbai-retrievers',
    description: 'A dedicated group for Golden, Labrador, and Flat-Coated Retrievers in Mumbai. Share retriever-specific tips, health advice, and beach run playdates.',
    cover_image_url: 'https://images.unsplash.com/photo-1552053831-71594a27632d?auto=format&fit=crop&q=80&w=800',
  },
  {
    name: 'Delhi Indie Dog Collective',
    slug: 'delhi-indie',
    description: 'Celebrating the resilient and beautiful indie dogs of Delhi-NCR. Dedicated to sharing adoption stories, local community feeding, and indie pet care tips.',
    cover_image_url: 'https://images.unsplash.com/photo-1537151608828-ea2b117b62e4?auto=format&fit=crop&q=80&w=800',
  },
  {
    name: 'Bengaluru Cat Parents',
    slug: 'blr-cats',
    description: 'For all cat parents and lovers in Bangalore. Share feline nutrition advice, local vet reviews, cute cat memes, and advice on behavior.',
    cover_image_url: 'https://images.unsplash.com/photo-1514888286974-6c03e2ca1dba?auto=format&fit=crop&q=80&w=800',
  },
  {
    name: 'Chennai Beagle Bunch',
    slug: 'chennai-beagles',
    description: 'A community for the energetic and scent-driven Beagles of Chennai. Tips on scent training, handling beagle energy, and organizing breed meets.',
    cover_image_url: 'https://images.unsplash.com/photo-1505628346881-b72b27e84530?auto=format&fit=crop&q=80&w=800',
  },
  {
    name: 'Pug Playgroup India',
    slug: 'pug-playgroup',
    description: 'A national club for pug parents. Share advice on managing pug health, breathing issues, hot weather care, and organizing local waddle meets.',
    cover_image_url: 'https://images.unsplash.com/photo-1517849845537-4d257902454a?auto=format&fit=crop&q=80&w=800',
  },
  {
    name: 'Persian Cats Society',
    slug: 'persian-cats',
    description: 'A dedicated club for Persian cat parents. Tips on coat grooming, specific dietary requirements, eye cleaning, and general flat-face care.',
    cover_image_url: 'https://images.unsplash.com/photo-1618826411640-d6df44dd3f7a?auto=format&fit=crop&q=80&w=800',
  },
  {
    name: 'German Shepherds Club',
    slug: 'german-shepherds',
    description: 'For parents of German Shepherds in India. Share grooming tips, joint health advice, training guidelines, and active playdates.',
    cover_image_url: 'https://images.unsplash.com/photo-1589941013453-ec89f33b5e95?auto=format&fit=crop&q=80&w=800',
  },
  {
    name: 'Golden Retriever Gang',
    slug: 'golden-retrievers',
    description: 'The happiest, goldest community on Furlo. Share your retriever smiles, pool day meetups, and shedding survival hacks.',
    cover_image_url: 'https://images.unsplash.com/photo-1477884213960-b99d860df874?auto=format&fit=crop&q=80&w=800',
  },
  {
    name: 'Indie Pets Love',
    slug: 'indie-pets-love',
    description: 'For parents of all indie dogs and cats. Supporting adoption, sharing rescue stories, and advice on healthy care.',
    cover_image_url: 'https://images.unsplash.com/photo-1444212477490-ca407925329e?auto=format&fit=crop&q=80&w=800',
  },
  {
    name: 'Pune Puppy Playdates',
    slug: 'pune-puppies',
    description: 'Puppy socialization group based in Pune. Organize socialization dates, training sessions, and general advice for new pet parents.',
    cover_image_url: 'https://images.unsplash.com/photo-1596492784531-6e6eb5ea9993?auto=format&fit=crop&q=80&w=800',
  },
  {
    name: 'Hyderabad Huskies Group',
    slug: 'hyd-huskies',
    description: 'A collective of Husky and Arctic breed parents in Hyderabad. Essential tips on cooling, managing double coats, and training these escape artists.',
    cover_image_url: 'https://images.unsplash.com/photo-1531353826977-0941b4779a1c?auto=format&fit=crop&q=80&w=800',
  },
  {
    name: 'Kolkata Kittens Club',
    slug: 'kolkata-kittens',
    description: 'A community for cat parents in Kolkata. Sharing tips on keeping cats safe indoors, local fish treats, and vet recommendations.',
    cover_image_url: 'https://images.unsplash.com/photo-1533738363-b7f9aef128ce?auto=format&fit=crop&q=80&w=800',
  },
  {
    name: 'Toy Breeds Club India',
    slug: 'toy-breeds',
    description: 'For Shih Tzus, Malteses, Pomeranians, and other toy breed parents. Tips on dental care, small breed nutrition, and gentle play meets.',
    cover_image_url: 'https://images.unsplash.com/photo-1518020382113-a7e8fc38eac9?auto=format&fit=crop&q=80&w=800',
  },
  {
    name: 'Feline Friends Bengaluru',
    slug: 'feline-friends-blr',
    description: 'Bengaluru cat lovers community. Helping with cat adoptions, rescue networks, and sharing kitty play recommendations.',
    cover_image_url: 'https://images.unsplash.com/photo-1495360010541-f48722b34f7d?auto=format&fit=crop&q=80&w=800',
  },
  {
    name: 'Pet Parents of Goa',
    slug: 'pet-parents-goa',
    description: 'Goa-based pet parents sharing local recommendations for pet-friendly beaches, restaurants, and emergency vet services.',
    cover_image_url: 'https://images.unsplash.com/photo-1560807707-8cc77767d783?auto=format&fit=crop&q=80&w=800',
  },
  {
    name: 'Adoption Advocates India',
    slug: 'adoption-advocates',
    description: 'A group of volunteers, fosters, and rescuers raising awareness for pet adoption and welfare across India.',
    cover_image_url: 'https://images.unsplash.com/photo-1489710437720-ebb67ec84dd2?auto=format&fit=crop&q=80&w=800',
  },
  {
    name: 'Working Dogs Pack',
    slug: 'working-dogs',
    description: 'For guard, protection, search-and-rescue, and service dog parents. Scent work, agility, and behavioral training tips.',
    cover_image_url: 'https://images.unsplash.com/photo-1534361960057-19889db9621e?auto=format&fit=crop&q=80&w=800',
  },
]

async function seed() {
  console.log('🌱 Seeding 18 communities to Supabase...')
  
  for (const c of communities) {
    const { data: existing } = await supabase
      .from('communities')
      .select('id')
      .eq('slug', c.slug)
      .limit(1)

    if (existing && existing.length > 0) {
      console.log(`ℹ️ Community "${c.name}" already exists. Skipping...`)
      continue
    }

    const { data, error } = await supabase
      .from('communities')
      .insert(c)
      .select()
      .single()

    if (error) {
      console.error(`❌ Failed to insert "${c.name}":`, error.message)
    } else {
      console.log(`✓ Seeded community: "${data.name}"`)
    }
  }

  console.log('✓ Seeding complete!')
  process.exit(0)
}

seed()
