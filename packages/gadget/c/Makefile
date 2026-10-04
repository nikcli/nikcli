# Host build and self-check of the C client. ESP-IDF and libnx build the same sources with their own toolchains.
CC ?= cc
CFLAGS ?= -std=c11 -Wall -Wextra -Werror -O1 -g -fsanitize=address,undefined
INC = -Iinclude
SRC = src/nikcli_gadget.c src/ng_json.c platform/posix.c

build/host_gadget: $(SRC) examples/host_gadget.c include/nikcli_gadget.h include/ng_json.h
	@mkdir -p build
	$(CC) $(CFLAGS) $(INC) $(SRC) examples/host_gadget.c -o $@

.PHONY: clean
clean:
	rm -rf build
