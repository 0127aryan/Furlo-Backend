const BREEDS_BY_PET_TYPE: Record<string, string[]> = {
  dogs: [
    "Golden Retriever",
    "Labrador Retriever",
    "German Shepherd",
    "Indie / Indian Pariah Dog",
    "Beagle",
    "Shih Tzu",
    "Pug",
    "Poodle",
    "Rottweiler",
    "Siberian Husky",
    "Pomeranian",
    "Boxer",
    "Cocker Spaniel",
    "French Bulldog",
    "Dachshund",
    "Doberman Pinscher",
    "Great Dane",
    "Maltese",
    "Chihuahua",
    "American Bully",
    "Lhasa Apso",
    "Border Collie",
    "Australian Shepherd",
    "Chow Chow",
    "St. Bernard",
  ],
  cats: [
    "Persian",
    "Indie / Domestic Shorthair",
    "Siamese",
    "Maine Coon",
    "Bengal",
    "British Shorthair",
    "Ragdoll",
    "Sphynx",
    "Himalayan",
    "Scottish Fold",
    "Russian Blue",
    "Abyssinian",
    "Birman",
    "Turkish Angora",
  ],
  birds: [
    "Cockatiel",
    "Budgerigar / Budgie",
    "Lovebird",
    "African Grey Parrot",
    "Macaw",
    "Cockatoo",
    "Finch",
    "Canary",
    "Conure",
    "Indian Ringneck",
    "Parakeet",
  ],
  rabbits: [
    "Netherland Dwarf",
    "Holland Lop",
    "Mini Rex",
    "Lionhead",
    "Flemish Giant",
    "Angora",
    "Dutch Rabbit",
    "English Spot",
  ],
  hamsters: [
    "Syrian Hamster",
    "Dwarf Campbell Russian",
    "Dwarf Winter White",
    "Roborovski Dwarf",
    "Chinese Hamster",
  ],
};

const KEYWORD_TYPES: Array<[RegExp, string]> = [
  [/\b(cat|kitten|feline|persian|siamese|maine coon|bengal|ragdoll|sphynx)\b/i, "cats"],
  [/\b(rabbit|bunny|lop)\b/i, "rabbits"],
  [/\b(bird|parrot|cockatiel|budgie|macaw|finch|canary)\b/i, "birds"],
  [/\b(hamster|rodent)\b/i, "hamsters"],
  [/\b(dog|puppy|retriever|shepherd|terrier|bulldog|poodle|husky)\b/i, "dogs"],
  [/\blover\b/i, "lover"],
];

export function inferPetTypeFromBreed(
  breed?: string | null,
  explicit?: string | null,
): string | undefined {
  if (explicit && String(explicit).trim()) return String(explicit).trim();
  if (!breed) return undefined;
  const normalized = breed.toLowerCase().trim();
  for (const [petType, breeds] of Object.entries(BREEDS_BY_PET_TYPE)) {
    if (breeds.some((item) => item.toLowerCase() === normalized)) {
      return petType;
    }
  }
  for (const [pattern, petType] of KEYWORD_TYPES) {
    if (pattern.test(normalized)) return petType;
  }
  return undefined;
}

export function attachPetType<T extends { breed?: string; pet_type?: string }>(
  pet: T | T[] | null | undefined,
): T | T[] | null | undefined {
  if (!pet) return pet;
  if (Array.isArray(pet)) {
    return pet.map((item) => ({
      ...item,
      pet_type: inferPetTypeFromBreed(item?.breed, item?.pet_type),
    })) as T[];
  }
  return {
    ...pet,
    pet_type: inferPetTypeFromBreed(pet.breed, pet.pet_type),
  };
}
