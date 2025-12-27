use holochain_integrity_types::prelude::*;
use holochain_serialized_bytes::prelude::*;
use holo_hash::ActionHash;

fn print_bytes(label: &str, bytes: &[u8]) {
    println!("\n=== {} ===", label);
    println!("Length: {} bytes", bytes.len());
    println!("Hex: {}", hex::encode(bytes));
    println!("Dec: {:?}", bytes);
    println!("First 20: {:?}", &bytes[..20.min(bytes.len())]);
}

fn main() {
    // Test Case 1: ActionHash wrapped in Result::Ok
    // Using exact bytes from test-zome logs
    let hash_bytes = vec![
        132, 41, 36, 129, 10, 140, 151, 66, 20, 198, 107, 227, 244, 220,
        175, 133, 244, 112, 233, 112, 140, 211, 145, 176, 182, 141, 77,
        137, 213, 160, 26, 122, 35, 82, 232, 159, 178, 77, 227
    ]; // 39 bytes total
    let hash = ActionHash::from_raw_39(hash_bytes.clone().try_into().unwrap());
    // For testing, we'll use String as error type (simpler than WasmError)
    let result: Result<ActionHash, String> = Ok(hash.clone());

    // Serialize directly
    let bytes_direct = holochain_serialized_bytes::encode(&result).unwrap();
    print_bytes("Result<ActionHash, String>", &bytes_direct);

    // Serialize as ExternIO would
    let extern_io = ExternIO::encode(&result).unwrap();
    let bytes_externio_inner = extern_io.0.clone();
    print_bytes("ExternIO.encode(Result<ActionHash>) - inner bytes", &bytes_externio_inner);

    // Serialize ExternIO itself (what conductor would send over wire)
    let bytes_externio_serialized = holochain_serialized_bytes::encode(&extern_io).unwrap();
    print_bytes("ExternIO serialized", &bytes_externio_serialized);

    // Test Case 2: String in Result
    let result_str: Result<String, String> = Ok("test".to_string());
    let bytes_str = holochain_serialized_bytes::encode(&result_str).unwrap();
    print_bytes("Result<String, String>", &bytes_str);

    // Test Case 3: Raw ActionHash (no Result)
    let bytes_hash_only = holochain_serialized_bytes::encode(&hash).unwrap();
    print_bytes("ActionHash (no Result)", &bytes_hash_only);

    // Test Case 4: Unit type () - for zero-argument functions
    let unit_value = ();
    let bytes_unit = holochain_serialized_bytes::encode(&unit_value).unwrap();
    print_bytes("Unit () - zero-argument encoding", &bytes_unit);

    // Test Case 5: Unit in ExternIO - what get_agent_info() expects
    let extern_io_unit = ExternIO::encode(&unit_value).unwrap();
    print_bytes("ExternIO.encode(()) - inner bytes", &extern_io_unit.0);

    println!("\n=== SUMMARY ===");
    println!("All test cases completed successfully");
}
