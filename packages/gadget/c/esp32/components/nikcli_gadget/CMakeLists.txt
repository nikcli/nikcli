# The portable client, built as an ESP-IDF component from the shared sources.
idf_component_register(
    SRCS "../../../src/nikcli_gadget.c" "../../../src/ng_json.c"
    INCLUDE_DIRS "../../../include"
    REQUIRES lwip
)
