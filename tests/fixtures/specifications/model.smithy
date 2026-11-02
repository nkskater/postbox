$version: "2"
namespace pets
@documentation("Browse pets")
service Pets { version: "1", operations: [Get] }
operation Get { input: PetRequest, output: Pet }
structure PetRequest { id: String }
structure Pet { name: String }
