#!/usr/bin/env python3
"""Register Datapom's selected-message action in your own Discord application."""
import getpass
import argparse
from pathlib import Path
import sys
import warnings
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import discord_journal
import discord_setup


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--application-id', help='Expected Discord application ID; prompted when omitted')
    parser.add_argument('--setup-info', type=Path, help='Merge verified non-secret IDs into this local JSON file')
    args = parser.parse_args(argv)
    try:
        identity = discord_journal.snowflake((args.application_id or input('Discord application ID: ')).strip())
        with warnings.catch_warnings():
            # getpass must never fall back to visibly echoing the bot token.
            warnings.simplefilter('error', getpass.GetPassWarning)
            token = getpass.getpass('Application bot token (hidden; never saved): ').strip()
        try:
            metadata = discord_setup.register(identity, token)
        finally:
            token = None
        if args.setup_info:
            discord_setup.save_info(args.setup_info, metadata)
        print(f'{discord_journal.COMMAND["name"]} registered for {metadata["application_name"]}.')
        if args.setup_info:
            print('Verified application and owner IDs saved. The bot token was not saved.')
        else:
            print('Install the application for your Discord account.')
        return 0
    except getpass.GetPassWarning:
        print('Run this command in an interactive terminal so the bot token stays hidden.', file=sys.stderr)
        return 1
    except (ValueError, OSError) as error:
        print(str(error), file=sys.stderr)
        return 1
    except (EOFError, KeyboardInterrupt):
        print('\nSetup cancelled.', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
